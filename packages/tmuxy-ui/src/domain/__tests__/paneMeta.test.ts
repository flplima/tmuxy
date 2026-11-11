import { describe, expect, it } from 'vitest';
import { paneFields } from '../paneMeta';

const b64 = (value: unknown) =>
  btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(value))));

describe('a pane’s custom fields', () => {
  it('are read from the option, in key order, any text included', () => {
    const option = b64({ task: { v: 'parser rewrite ✓' }, ci: { v: 'passing' } });
    expect(paneFields(option, 0)).toEqual([
      { key: 'ci', value: 'passing' },
      { key: 'task', value: 'parser rewrite ✓' },
    ]);
    expect(paneFields('', 0)).toEqual([]);
  });

  it('leave out a field whose time is up', () => {
    const option = b64({ deploy: { v: 'running', until: 100 }, ci: { v: 'passing' } });
    expect(paneFields(option, 99).map((f) => f.key)).toEqual(['ci', 'deploy']);
    expect(paneFields(option, 100).map((f) => f.key)).toEqual(['ci']);
  });

  it('show nothing of an option that breaks the rules', () => {
    for (const bad of [
      'not base64!',
      b64([1, 2]),
      b64({ ci: 'not an object' }),
      b64({ CI: { v: 'upper-case key' } }),
      b64({ ci: { v: 'line\nbreak' } }),
      b64({ ci: { v: '' } }),
      b64({ ci: { v: ' padded ' } }),
      b64({ ci: { v: 'x'.repeat(81) } }),
      b64({ ci: { v: 'x', until: 'later' } }),
      b64(Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`k${i}`, { v: 'x' }]))),
    ]) {
      expect(paneFields(bad, 0)).toEqual([]);
    }
  });
});
