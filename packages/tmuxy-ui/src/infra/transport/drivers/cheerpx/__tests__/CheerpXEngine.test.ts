import { describe, expect, it } from 'vitest';
import { verifySubresourceIntegrity } from '../CheerpXEngine';
import { CX_IMPORT_MAP, CX_INTEGRITY, CX_URL } from '../cheerpxRuntime';

const fetchReturning = (body: string) =>
  (async () => new Response(body, { status: 200 })) as unknown as typeof fetch;

async function sriOf(body: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-384', new TextEncoder().encode(body));
  return `sha384-${btoa(String.fromCharCode(...new Uint8Array(digest)))}`;
}

describe('CheerpX runtime integrity', () => {
  it('runs a module whose bytes match the pinned digest and refuses one that changed', async () => {
    const sri = await sriOf('export const ok = 1;\n');
    await expect(
      verifySubresourceIntegrity(CX_URL, sri, fetchReturning('export const ok = 1;\n')),
    ).resolves.toBeUndefined();
    await expect(
      verifySubresourceIntegrity(CX_URL, sri, fetchReturning('export const ok = 2;\n')),
    ).rejects.toThrow(/Integrity check failed/);
  });

  it('refuses metadata it cannot check rather than letting the module through', async () => {
    await expect(
      verifySubresourceIntegrity(CX_URL, 'sha256-anything', fetchReturning('')),
    ).rejects.toThrow(/Unsupported integrity metadata/);
  });

  it('gives the page an import map pinning the module the engine imports', () => {
    const map = JSON.parse(CX_IMPORT_MAP) as { integrity: Record<string, string> };
    expect(map.integrity[CX_URL]).toBe(CX_INTEGRITY[CX_URL]);
    for (const sri of Object.values(map.integrity)) {
      expect(sri).toMatch(/^sha384-[A-Za-z0-9+/]{64}$/);
    }
  });
});
