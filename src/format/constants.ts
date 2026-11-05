/** PWN-1: one deliberately bounded envelope and one QR policy. */
export const BACKUP_BYTES = 2858;
export const MAX_MESSAGES = 2;
export const PREAMBLE_BYTES = 8;
export const SALT_BYTES = 16;
export const PAYLOAD_OFFSET = PREAMBLE_BYTES + SALT_BYTES;
export const PAYLOAD_BYTES = BACKUP_BYTES - PAYLOAD_OFFSET;
export const HEADER_BYTES = 30;
export const DATA_OVERHEAD = 28;
export const RECORD_OVERHEAD = HEADER_BYTES + DATA_OVERHEAD;
export const MAX_TEXT_BYTES = PAYLOAD_BYTES - RECORD_OVERHEAD;
export const PREAMBLE = new Uint8Array([0x50, 0x57, 0x4e, 0x31, 1, 1, 0, 0]);
export function maximumTextBytes(messageCount: number): number {
  if (
    !Number.isInteger(messageCount) ||
    messageCount < 1 ||
    messageCount > MAX_MESSAGES
  ) {
    throw new RangeError("Message count must be between 1 and 2.");
  }
  return PAYLOAD_BYTES - RECORD_OVERHEAD * messageCount;
}
