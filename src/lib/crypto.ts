import crypto from 'crypto';

/**
 * Symmetric encryption for storing third-party credentials (IMAP/SMTP
 * passwords, WhatsApp access tokens) at rest. Uses AES-256-GCM with a key
 * derived from IMAP_ENCRYPTION_KEY (set a 32-byte hex string in .env).
 */
function getKey(): Buffer {
  const raw = process.env.IMAP_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error('IMAP_ENCRYPTION_KEY is not set');
  }
  // Accept either a 64-char hex string or an arbitrary passphrase (hashed to 32 bytes).
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    return Buffer.from(raw, 'hex');
  }
  return crypto.createHash('sha256').update(raw).digest();
}

export function encryptSecret(plainText: string): string {
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString('hex'), authTag.toString('hex'), encrypted.toString('hex')].join(':');
}

export function decryptSecret(payload: string): string {
  const key = getKey();
  const [ivHex, tagHex, dataHex] = payload.split(':');
  if (!ivHex || !tagHex || !dataHex) {
    throw new Error('Invalid encrypted payload');
  }
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(dataHex, 'hex')),
    decipher.final(),
  ]);
  return decrypted.toString('utf8');
}
