/**
 * Coerce a Buffer or string to a string, using UTF-8 decoding for Buffers.
 */
export function ensureString(data: Buffer | string): string {
  return Buffer.isBuffer(data) ? data.toString('utf-8') : data;
}
