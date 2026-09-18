# syntax=docker/dockerfile:1

# ---- Dependencies -----------------------------------------------------------
FROM node:20-alpine AS deps
WORKDIR /app
RUN apk add --no-cache libc6-compat openssl
COPY package.json package-lock.json* ./
RUN npm ci

# ---- Build -------------------------------------------------------------------
FROM node:20-alpine AS builder
WORKDIR /app
RUN apk add --no-cache openssl
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
# DATABASE_URL is only needed here so `prisma generate` can read the schema;
# no database connection is made at build time.
ENV DATABASE_URL="postgresql://user:pass@localhost:5432/db"
RUN npx prisma generate
RUN npm run build

# ---- Worker (optional background automations/email-sync process) -----------
# Reuses the full source + devDependencies (needs tsx) rather than the
# trimmed standalone runtime, since it runs TypeScript directly.
FROM node:20-alpine AS worker
WORKDIR /app
RUN apk add --no-cache openssl
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate
ENV NODE_ENV=production
CMD ["npx", "tsx", "src/worker/index.ts"]

# ---- Runtime -------------------------------------------------------------------
FROM node:20-alpine AS runner
WORKDIR /app
RUN apk add --no-cache openssl
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 nextjs

# Next.js standalone output: minimal self-contained server bundle.
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma

# Persistent storage for uploaded documents/attachments/PDFs.
RUN mkdir -p /app/uploads && chown -R nextjs:nodejs /app/uploads
VOLUME ["/app/uploads"]

USER nextjs

# Easypanel (and most PaaS) inject PORT at runtime; default to 3000 locally.
ENV PORT=3000
EXPOSE 3000

# server.js (from the standalone build) binds to 0.0.0.0 automatically when
# HOSTNAME is set, which Next.js does by default in standalone mode.
ENV HOSTNAME="0.0.0.0"

CMD ["node", "server.js"]
