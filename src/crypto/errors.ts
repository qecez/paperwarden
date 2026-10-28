export type ErrorCode =
  | "format"
  | "version"
  | "profile"
  | "password"
  | "duplicate"
  | "capacity"
  | "empty"
  | "messages"
  | "auth"
  | "resource"
  | "qr"
  | "archive";
export class PaperError extends Error {
  constructor(public readonly code: ErrorCode) {
    super(code);
    this.name = "PaperError";
  }
}
const messages: Record<ErrorCode, string> = {
  format:
    "This is not a complete Paperwarden backup. Check the copied text, link, or photo.",
  version:
    "This backup uses a different format. Open it with the reader that created it.",
  profile: "This backup uses an unsupported password method.",
  password:
    "Enter a password of at most 1,024 UTF-8 bytes. Spaces and capital letters matter.",
  duplicate: "Use a different password for each message.",
  capacity:
    "The messages do not fit in this backup. Shorten the text using the backup-space meter.",
  empty: "Enter text for every message, or remove the empty message.",
  messages: "A backup can contain one to four messages.",
  auth: "We couldn't open this backup with that password. Check the password and the backup, then try again.",
  resource:
    "This browser could not complete the password calculation. Close other apps and try again, or open the saved reader in another browser.",
  qr: "The QR code could not be read or created. Try a clearer photo or the encrypted text.",
  archive:
    "The written copy is incomplete or contains a copying error. Check its line numbers, checksums, and fingerprint.",
};
export function friendly(error: unknown): string {
  return error instanceof PaperError
    ? messages[error.code]
    : "Something went wrong on this device. Please try again.";
}
export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === "string" && Object.hasOwn(messages, value);
}
