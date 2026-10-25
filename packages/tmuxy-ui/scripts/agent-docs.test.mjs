// The generator lives with the site that serves its output
// (packages/tmuxy-demo/scripts/agent-docs.mjs); its test lives here, in the
// unit suite CI runs, because the demo package has no test runner of its own.
import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  absolutizeLinks,
  buildLlmsFull,
  buildSearchIndex,
  readDocs,
  slugify,
  splitSections,
  writeAgentDocs,
} from '../../tmuxy-demo/scripts/agent-docs.mjs';

const DOCS = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'docs');
const BLOB = 'https://github.com/flplima/tmuxy/blob/main/';

describe('slugify', () => {
  it('gives the anchor GitHub gives the heading', () => {
    expect(slugify('Remote servers over SSH (desktop app)')).toBe(
      'remote-servers-over-ssh-desktop-app',
    );
    expect(slugify('`tmuxy server --read-only`: viewers')).toBe('tmuxy-server---read-only-viewers');
    expect(slugify('See [the guide](GUIDE.md) first')).toBe('see-the-guide-first');
    expect(slugify('snake_case stays')).toBe('snake_case-stays');
  });
});

describe('splitSections', () => {
  it('splits at headings, numbers repeated anchors, and ignores # inside a fence', () => {
    const markdown = [
      '# Title',
      'intro',
      '## Usage',
      '```sh',
      '# not a heading',
      '```',
      '## Usage',
      'again',
    ].join('\n');
    expect(splitSections(markdown)).toEqual([
      { heading: 'Title', level: 1, anchor: 'title', text: 'intro' },
      { heading: 'Usage', level: 2, anchor: 'usage', text: '```sh\n# not a heading\n```' },
      { heading: 'Usage', level: 2, anchor: 'usage-1', text: 'again' },
    ]);
  });
});

describe('absolutizeLinks', () => {
  it('re-aims relative links at their canonical URL and leaves absolute ones', () => {
    const out = absolutizeLinks(
      '[a](OTHER.md#x) [b](#here) [c](../packages/x.rs) [d](https://example.com) [e](mailto:a@b)',
      'docs/THIS.md',
    );
    expect(out).toBe(
      `[a](${BLOB}docs/OTHER.md#x) [b](${BLOB}docs/THIS.md#here) [c](${BLOB}packages/x.rs) [d](https://example.com) [e](mailto:a@b)`,
    );
  });
});

describe('the generated files', () => {
  it('put every doc under its canonical URL, and index every section with a working anchor', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-docs-'));
    try {
      writeFileSync(join(dir, 'ZED.md'), '# Zed\n\nSee [Alpha](ALPHA.md#part-two).\n');
      writeFileSync(join(dir, 'ALPHA.md'), '# Alpha\n\none\n\n## Part two\n\ntwo\n');
      writeFileSync(join(dir, 'README.md'), '# Guide\n\nstart here\n');
      const out = join(dir, 'public');
      expect(writeAgentDocs(dir, out)).toBe(3);

      const text = readFileSync(join(out, 'llms-full.txt'), 'utf8');
      const order = ['README', 'ALPHA', 'ZED'].map((name) =>
        text.indexOf(`\n${BLOB}docs/${name}.md\n`),
      );
      expect(order.every((at) => at > 0)).toBe(true);
      expect([...order].sort((a, b) => a - b)).toEqual(order);
      expect(text).toContain(`See [Alpha](${BLOB}docs/ALPHA.md#part-two).`);

      const index = JSON.parse(readFileSync(join(out, 'search.json'), 'utf8'));
      expect(index.sections).toContainEqual({
        doc: 'docs/ALPHA.md',
        heading: 'Part two',
        level: 2,
        url: `${BLOB}docs/ALPHA.md#part-two`,
        text: 'two',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('cover every file in docs/, and every link between docs names a section that exists', () => {
    const docs = readDocs(DOCS);
    const text = buildLlmsFull(docs);
    for (const { path } of docs) expect(text).toContain(`\n${BLOB}${path}\n`);

    const anchors = new Set(buildSearchIndex(docs).sections.map((section) => section.url));
    const links = [...text.matchAll(/\]\((https:\/\/[^)\s]+\/docs\/[^)\s]+\.md#[^)\s]+)\)/g)];
    const broken = links.map((link) => link[1]).filter((url) => !anchors.has(url));
    expect(broken).toEqual([]);
  });
});
