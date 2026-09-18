import { NextRequest, NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { z } from 'zod';

export const runtime = 'nodejs';

/**
 * Receives contact-form submissions from WordPress (via a webhook plugin
 * such as WPForms + Webhooks, Contact Form 7 + CF7 to Webhook, or Gravity
 * Forms webhooks add-on). Configure that plugin to POST here with header
 * `x-webhook-secret: $WORDPRESS_WEBHOOK_SECRET`.
 *
 * Creates/updates the matching Contact (by email) and Company (by name, if
 * provided), and always records a WordPressLead with the raw payload, source
 * page, submission date, and consent flag — never inferring consent.
 */
const schema = z.object({
  siteId: z.string().optional(),
  formName: z.string().optional(),
  sourceUrl: z.string().optional(),
  submittedAt: z.string().optional(),
  consent: z.boolean().default(false),
  consentText: z.string().optional(),
  fields: z.object({
    firstName: z.string().optional(),
    lastName: z.string().optional(),
    name: z.string().optional(),
    email: z.string().email().optional(),
    phone: z.string().optional(),
    company: z.string().optional(),
    message: z.string().optional(),
  }).passthrough(),
});

export async function POST(req: NextRequest) {
  const secret = req.headers.get('x-webhook-secret');
  if (!process.env.WORDPRESS_WEBHOOK_SECRET || secret !== process.env.WORDPRESS_WEBHOOK_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const site =
    (parsed.data.siteId && (await prisma.wordPressSite.findUnique({ where: { id: parsed.data.siteId } }))) ||
    (await prisma.wordPressSite.findFirst());

  if (!site) {
    return NextResponse.json({ error: 'No WordPress site configured in the CRM yet' }, { status: 400 });
  }

  const { fields } = parsed.data;
  const firstName = fields.firstName || fields.name?.split(' ')[0] || 'Website';
  const lastName = fields.lastName || fields.name?.split(' ').slice(1).join(' ') || 'Lead';

  let company = null;
  if (fields.company) {
    company = await prisma.company.upsert({
      where: { id: `wp-${site.id}-${fields.company.toLowerCase().replace(/\s+/g, '-')}` },
      create: { id: `wp-${site.id}-${fields.company.toLowerCase().replace(/\s+/g, '-')}`, name: fields.company, type: 'CUSTOMER' },
      update: {},
    }).catch(() => null);
  }

  let contact = null;
  if (fields.email) {
    contact = await prisma.contact.findFirst({ where: { email: fields.email } });
    if (contact) {
      contact = await prisma.contact.update({
        where: { id: contact.id },
        data: { phone: fields.phone || contact.phone, companyId: company?.id || contact.companyId },
      });
    } else {
      contact = await prisma.contact.create({
        data: { firstName, lastName, email: fields.email, phone: fields.phone, companyId: company?.id },
      });
    }
  }

  const lead = await prisma.wordPressLead.create({
    data: {
      wordpressSiteId: site.id,
      formName: parsed.data.formName,
      sourceUrl: parsed.data.sourceUrl,
      submittedAt: parsed.data.submittedAt ? new Date(parsed.data.submittedAt) : new Date(),
      rawData: parsed.data.fields as Prisma.InputJsonValue,
      consentGiven: parsed.data.consent,
      consentText: parsed.data.consentText,
      companyId: company?.id,
      contactId: contact?.id,
    },
  });

  if (contact) {
    await prisma.communicationLog.create({
      data: {
        type: 'NOTE',
        direction: 'INBOUND',
        subject: `Website form submission: ${parsed.data.formName || 'Contact form'}`,
        body: fields.message || JSON.stringify(fields),
        contactId: contact.id,
        companyId: company?.id,
      },
    });
  }

  return NextResponse.json({ ok: true, leadId: lead.id, contactId: contact?.id, companyId: company?.id });
}
