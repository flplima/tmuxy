import { describe, expect, it } from 'vitest';
import { CX_INTEGRITY, verifySubresourceIntegrity } from '../CheerpXEngine';

describe('CheerpX subresource integrity verification', () => {
  it('accepts bytes matching the pinned SHA-256 digest and rejects tampered bytes', async () => {
    const payload = new TextEncoder().encode('export const ok = 1;\n');
    const digestBuf = await crypto.subtle.digest('SHA-256', payload);
    const expectedHex = Array.from(new Uint8Array(digestBuf), (b) =>
      b.toString(16).padStart(2, '0'),
    ).join('');

    const okFetch = (async () => new Response(payload, { status: 200 })) as unknown as typeof fetch;
    await expect(
      verifySubresourceIntegrity('https://example.test/mod.js', expectedHex, okFetch),
    ).resolves.toBeUndefined();

    const tamperedFetch = (async () =>
      new Response('export const ok = 2;\n', { status: 200 })) as unknown as typeof fetch;
    await expect(
      verifySubresourceIntegrity('https://example.test/mod.js', expectedHex, tamperedFetch),
    ).rejects.toThrow(/Integrity check failed/);

    expect(CX_INTEGRITY).toHaveLength(2);
    for (const [, sha256] of CX_INTEGRITY) {
      expect(sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});
