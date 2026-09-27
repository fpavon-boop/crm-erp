/**
 * Stub only — no Walmart integration exists. No credentials are read, no
 * network calls are made. Exists so ChannelReference rows can be written
 * with channel: 'WALMART' once real work is scoped, without a schema change.
 */
export function notImplemented(): never {
  throw new Error('Walmart channel integration is not implemented yet.');
}
