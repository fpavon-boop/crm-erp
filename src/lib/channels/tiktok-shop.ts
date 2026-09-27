/**
 * Stub only — no TikTok Shop integration exists. No credentials are read,
 * no network calls are made. Exists so ChannelReference rows can be written
 * with channel: 'TIKTOK_SHOP' once real work is scoped, without a schema
 * change.
 */
export function notImplemented(): never {
  throw new Error('TikTok Shop channel integration is not implemented yet.');
}
