import crypto from 'crypto';

/**
 * Marketing credential vault: AES-256-GCM envelope for secrets the marketing
 * module has to persist (webhook signing secrets, internal service tokens).
 *
 * Deliberately separate from src/lib/crypto.ts (IMAP/WhatsApp credentials):
 * a different root key, so compromising or rotating one never touches the
 * other, and stricter rules —
 *
 * - The root key comes ONLY from the environment and must be exactly 32
 *   bytes (64 hex chars or base64). No passphrase fallback: a weak key is a
 *   configuration error, not something to paper over with a hash.
 * - Every ciphertext is bound to a caller-supplied `context` string via GCM
 *   additional authenticated data, so a ciphertext copied from one field
 *   (e.g. a social account's token) into another fails to decrypt.
 * - Payloads carry a key id, so the key can be rotated: new writes use the
 *   current key, old payloads still decrypt with a retired key listed in
 *   MARKETING_VAULT_PREVIOUS_KEYS, and needsRotation()/rotate() re-encrypt.
 *
 * Env:
 *   MARKETING_VAULT_KEY            current root key (64 hex or base64, 32 bytes)
 *   MARKETING_VAULT_KEY_ID         id for the current key (default "v1")
 *   MARKETING_VAULT_PREVIOUS_KEYS  optional "id:key,id:key" for decryption only
 *
 * Payload format: mv1.<keyId>.<iv>.<tag>.<ciphertext>  (base64url parts)
 */

const PREFIX = 'mv1';
const KEY_ID_RE = /^[A-Za-z0-9_-]{1,32}$/;

export class VaultNotConfiguredError extends Error {
  constructor(message = 'MARKETING_VAULT_KEY is not configured') {
    super(message);
    this.name = 'VaultNotConfiguredError';
  }
}

/** Deliberately generic: never reveals whether the key, context, or payload
 * was the problem. */
export class VaultDecryptError extends Error {
  constructor() {
    super('Unable to decrypt vault payload');
    this.name = 'VaultDecryptError';
  }
}

function parseKey(raw: string, name: string): Buffer {
  const trimmed = raw.trim();
  let key: Buffer | null = null;
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    key = Buffer.from(trimmed, 'hex');
  } else if (/^[A-Za-z0-9+/_-]{43}=?$/.test(trimmed)) {
    key = Buffer.from(trimmed.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  }
  if (!key || key.length !== 32) {
    throw new VaultNotConfiguredError(`${name} must be a 32-byte key (64 hex chars or base64)`);
  }
  return key;
}

function currentKey(): { id: string; key: Buffer } {
  const raw = process.env.MARKETING_VAULT_KEY;
  if (!raw) throw new VaultNotConfiguredError();
  const id = process.env.MARKETING_VAULT_KEY_ID || 'v1';
  if (!KEY_ID_RE.test(id)) throw new VaultNotConfiguredError('MARKETING_VAULT_KEY_ID is invalid');
  return { id, key: parseKey(raw, 'MARKETING_VAULT_KEY') };
}

function keyById(id: string): Buffer | null {
  const current = currentKey();
  if (current.id === id) return current.key;
  const previous = process.env.MARKETING_VAULT_PREVIOUS_KEYS;
  if (!previous) return null;
  for (const entry of previous.split(',')) {
    const sep = entry.indexOf(':');
    if (sep <= 0) continue;
    if (entry.slice(0, sep).trim() === id) {
      return parseKey(entry.slice(sep + 1), `MARKETING_VAULT_PREVIOUS_KEYS[${id}]`);
    }
  }
  return null;
}

function requireContext(context: string): Buffer {
  if (!context || !context.trim()) throw new Error('Vault context is required');
  return Buffer.from(context, 'utf8');
}

export function isVaultConfigured(): boolean {
  try {
    currentKey();
    return true;
  } catch {
    return false;
  }
}

export function encryptVaultSecret(plainText: string, context: string): string {
  const aad = requireContext(context);
  const { id, key } = currentKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [PREFIX, id, iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join('.');
}

function parsePayload(payload: string) {
  const parts = payload.split('.');
  if (parts.length !== 5 || parts[0] !== PREFIX || !KEY_ID_RE.test(parts[1])) {
    throw new VaultDecryptError();
  }
  const [, keyId, iv, tag, data] = parts;
  return { keyId, iv: Buffer.from(iv, 'base64url'), tag: Buffer.from(tag, 'base64url'), data: Buffer.from(data, 'base64url') };
}

export function decryptVaultSecret(payload: string, context: string): string {
  const aad = requireContext(context);
  const { keyId, iv, tag, data } = parsePayload(payload);
  const key = keyById(keyId);
  if (!key || iv.length !== 12 || tag.length !== 16) throw new VaultDecryptError();
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch {
    throw new VaultDecryptError();
  }
}

export function isVaultPayload(value: string): boolean {
  return value.startsWith(`${PREFIX}.`) && value.split('.').length === 5;
}

/** True when the payload was written with a key other than the current one. */
export function needsRotation(payload: string): boolean {
  return parsePayload(payload).keyId !== currentKey().id;
}

/** Re-encrypts a payload under the current key (no-op re-encryption if it
 * already uses it — a fresh IV is still generated). */
export function rotateSecret(payload: string, context: string): string {
  return encryptVaultSecret(decryptVaultSecret(payload, context), context);
}
