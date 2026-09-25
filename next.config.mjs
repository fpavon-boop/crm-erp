/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  eslint: {
    ignoreDuringBuilds: true,
  },
  experimental: {
    instrumentationHook: true,
    serverComponentsExternalPackages: ['pdfkit', 'imapflow', 'mailparser', 'nodemailer'],
  },
  // Phase 8 (SYSTEM_AUDIT.md D7): nothing in this app uses next/image, but
  // Next's built-in Image Optimization API (/_next/image) is on by default
  // regardless and is excluded from auth middleware (it has to be, to
  // serve unauthenticated pages), making it a live, unauthenticated attack
  // surface for the current npm-audit-flagged Next.js image-optimizer
  // RCE/DoS advisories. Disabling it here has zero functional impact (see
  // docs/SYSTEM_HARDENING.md "D7") and closes that surface without
  // requiring the major Next.js version bump `npm audit fix --force`
  // would otherwise pull in.
  images: {
    unoptimized: true,
  },
};

export default nextConfig;
