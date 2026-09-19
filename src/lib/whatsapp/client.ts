import { prisma } from '@/lib/prisma';
import { decryptSecret } from '@/lib/crypto';

const GRAPH_VERSION = 'v20.0';

interface SendTextParams {
  to: string;
  body: string;
}

interface SendTemplateParams {
  to: string;
  templateName: string;
  language?: string;
  components?: unknown[];
}

async function getActiveAccount() {
  const account = await prisma.whatsAppAccount.findFirst({ where: { active: true } });
  if (!account) {
    throw new Error(
      'No active WhatsApp Business account configured. Add one in Settings > WhatsApp, or set WHATSAPP_* env vars.'
    );
  }
  return account;
}

function accessToken(account: { encryptedAccessToken: string }): string {
  return decryptSecret(account.encryptedAccessToken);
}

async function graphFetch(path: string, token: string, init?: RequestInit) {
  const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init?.headers || {}),
    },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`WhatsApp API error (${res.status}): ${JSON.stringify(json)}`);
  }
  return json;
}

/** Sends a free-form text message. Only allowed within Meta's 24-hour customer
 * service window per WhatsApp Business policy — use sendTemplate() outside it. */
export async function sendText(params: SendTextParams) {
  const account = await getActiveAccount();
  const token = accessToken(account);
  const result = await graphFetch(`${account.phoneNumberId}/messages`, token, {
    method: 'POST',
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: params.to,
      type: 'text',
      text: { body: params.body },
    }),
  });

  await prisma.whatsAppMessage.create({
    data: {
      waMessageId: result?.messages?.[0]?.id,
      direction: 'OUTBOUND',
      fromNumber: account.displayPhoneNumber || account.phoneNumberId,
      toNumber: params.to,
      messageType: 'text',
      body: params.body,
      status: 'SENT',
    },
  });

  return result;
}

/** Sends a pre-approved message template (required to initiate contact, or to
 * message outside the 24h window). Template must already be APPROVED in Meta
 * Business Manager. */
export async function sendTemplate(params: SendTemplateParams) {
  const account = await getActiveAccount();
  const token = accessToken(account);
  const result = await graphFetch(`${account.phoneNumberId}/messages`, token, {
    method: 'POST',
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: params.to,
      type: 'template',
      template: {
        name: params.templateName,
        language: { code: params.language || 'en_US' },
        components: params.components || [],
      },
    }),
  });

  await prisma.whatsAppMessage.create({
    data: {
      waMessageId: result?.messages?.[0]?.id,
      direction: 'OUTBOUND',
      fromNumber: account.displayPhoneNumber || account.phoneNumberId,
      toNumber: params.to,
      messageType: 'template',
      templateName: params.templateName,
      status: 'SENT',
    },
  });

  return result;
}

/** Parses an inbound Meta webhook payload, stores messages, and links them to
 * a matching Contact by phone number. See /api/whatsapp/webhook route. */
export async function handleInboundWebhook(rawPayload: unknown) {
  // Accept Meta's raw shape ({entry:[{changes:[{value}]}]}) as well as the
  // slimmer shape relays like n8n's WhatsApp Trigger emit ({messages, metadata}),
  // either as a single object or an array of them.
  const items = Array.isArray(rawPayload) ? rawPayload : [rawPayload];
  const entries: unknown[] = [];
  for (const item of items as Array<Record<string, unknown> | null>) {
    if (!item) continue;
    if (Array.isArray(item.entry)) entries.push(...(item.entry as unknown[]));
    else if (Array.isArray(item.messages)) entries.push({ changes: [{ value: item }] });
  }
  let stored = 0;

  for (const entry of entries as any[]) {
    for (const change of entry.changes || []) {
      const value = change.value;
      for (const msg of value?.messages || []) {
        const fromNumber = msg.from as string;
        if (msg.id && (await prisma.whatsAppMessage.findUnique({ where: { waMessageId: msg.id } }))) continue;
        const contact = await prisma.contact.findFirst({
          where: { OR: [{ phone: { contains: fromNumber } }, { mobile: { contains: fromNumber } }] },
        });

        await prisma.whatsAppMessage.create({
          data: {
            waMessageId: msg.id,
            direction: 'INBOUND',
            fromNumber,
            toNumber: value?.metadata?.display_phone_number || '',
            messageType: msg.type || 'text',
            body: msg.text?.body || msg.button?.text || null,
            status: 'DELIVERED',
            contactId: contact?.id,
            companyId: contact?.companyId,
          },
        });
        stored += 1;

        if (contact) {
          await prisma.communicationLog.create({
            data: {
              type: 'WHATSAPP',
              direction: 'INBOUND',
              body: msg.text?.body,
              contactId: contact.id,
              companyId: contact.companyId,
            },
          });
        }
      }
    }
  }

  return { stored };
}
