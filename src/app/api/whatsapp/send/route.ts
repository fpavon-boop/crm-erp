import { NextRequest, NextResponse } from 'next/server';
import { requireApiModule } from '@/lib/api-auth';
import { sendText, sendTemplate } from '@/lib/whatsapp/client';
import { z } from 'zod';

const schema = z.union([
  z.object({ mode: z.literal('text'), to: z.string().min(1), body: z.string().min(1) }),
  z.object({
    mode: z.literal('template'),
    to: z.string().min(1),
    templateName: z.string().min(1),
    language: z.string().optional(),
  }),
]);

export async function POST(req: NextRequest) {
  const session = await requireApiModule('whatsapp');
  if (session instanceof NextResponse) return session;

  const body = await req.json();
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  try {
    const result =
      parsed.data.mode === 'text'
        ? await sendText({ to: parsed.data.to, body: parsed.data.body })
        : await sendTemplate({ to: parsed.data.to, templateName: parsed.data.templateName, language: parsed.data.language });
    return NextResponse.json({ result });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
