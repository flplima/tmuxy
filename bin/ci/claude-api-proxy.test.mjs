import { describe, expect, it } from 'vitest';
import { allowed, upstreamHeaders } from './claude-api-proxy.mjs';

describe('the Claude review API proxy', () => {
  it('forwards only the messages endpoints', () => {
    expect(allowed('POST', '/v1/messages')).toBe(true);
    expect(allowed('POST', '/v1/messages?beta=true')).toBe(true);
    expect(allowed('POST', '/v1/messages/count_tokens')).toBe(true);
    expect(allowed('GET', '/v1/messages')).toBe(false);
    expect(allowed('POST', '/v1/files')).toBe(false);
    expect(allowed('POST', '/v1/messages/batches')).toBe(false);
    expect(allowed('POST', '/api/oauth/claude_cli/create_api_key')).toBe(false);
    expect(allowed('POST', '/v1/messages/../files')).toBe(false);
  });

  it("replaces whatever credential the request brings with the account's token", () => {
    const out = upstreamHeaders(
      {
        authorization: 'Bearer someone-elses',
        'X-Api-Key': 'sk-ant-api03-attacker',
        host: 'evil.example',
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'fine-grained-tool-streaming-2025-05-14',
      },
      'the-real-token',
    );
    expect(out.authorization).toBe('Bearer the-real-token');
    expect(Object.keys(out).map((k) => k.toLowerCase())).not.toContain('x-api-key');
    expect(out.host).toBeUndefined();
    expect(out['anthropic-version']).toBe('2023-06-01');
    expect(out['anthropic-beta']).toBe('fine-grained-tool-streaming-2025-05-14,oauth-2025-04-20');
  });
});
