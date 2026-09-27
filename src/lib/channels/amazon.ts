/**
 * Stub only — no Amazon integration exists. No credentials are read, no
 * network calls are made. Exists so ChannelReference rows can be written
 * with channel: 'AMAZON' once real work is scoped, without a schema change.
 */
export function notImplemented(): never {
  throw new Error('Amazon channel integration is not implemented yet.');
}
