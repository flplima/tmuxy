/**
 * Base64 to text, as UTF-8. `atob` yields one char per BYTE, so a multi-byte
 * character (an accent, an emoji) has to be decoded as UTF-8 rather than read
 * off as Latin-1. Throws on input that is not base64.
 */
export function decodeBase64Text(b64: string): string {
  return new TextDecoder().decode(Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0)));
}
