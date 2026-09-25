import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return NextResponse.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      database: 'connected',
    });
  } catch (error) {
    // This endpoint is unauthenticated by design (needed for uptime
    // checks), so the failure detail is logged server-side only — the raw
    // error message (which can include connection strings, internal
    // hostnames, or driver internals) must never reach a public,
    // unauthenticated response.
    console.error('[health] database check failed:', error);
    return NextResponse.json(
      {
        status: 'error',
        timestamp: new Date().toISOString(),
        database: 'unreachable',
      },
      { status: 503 }
    );
  }
}
