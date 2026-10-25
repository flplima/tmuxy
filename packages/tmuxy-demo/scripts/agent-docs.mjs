// The docs for agents, built from docs/ into two static files the site
// serves: /llms-full.txt, every doc in one file, each under a header naming
// its canonical URL; and /search.json, one entry per section, for an agent
// to fetch and filter itself (a static export cannot answer a query). Run
// before `next dev` and `next build`; neither file is in git.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

export const BLOB_BASE = 'https://github.com/flplima/tmuxy/blob/main/';
const SITE = 'https://tmuxy.sh';

/** The GitHub URL a repo path is read at. */
export const canonicalUrl = (repoPath) => BLOB_BASE + repoPath;

/** The anchor GitHub gives a heading: its rendered text, lowercased, with
 *  punctuation dropped and spaces turned into hyphens. */
export function slugify(heading) {
  return heading
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '')
    .replace(/ /g, '-');
}

/** A relative link in a doc, re-aimed at its canonical URL, since the
 *  concatenation has no neighbouring files for it to resolve against. */
export function absolutizeLinks(markdown, repoPath) {
  return markdown.replace(/(\]\()([^)\s]+)(\))/g, (whole, open, target, close) => {
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return whole;
    if (target.startsWith('#')) return open + canonicalUrl(repoPath) + target + close;
    const resolved = posix.normalize(posix.join(posix.dirname(repoPath), target));
    if (resolved.startsWith('..')) return whole;
    return open + canonicalUrl(resolved) + close;
  });
}

/** A doc split at its headings (not at a `#` inside a code fence): one
 *  section per heading, the text under it up to the next heading. Text
 *  before the first heading is left out, which no doc has. */
export function splitSections(markdown) {
  const sections = [];
  const seen = new Map();
  let fence = null;
  let current = null;
  for (const line of markdown.split('\n')) {
    const marker = line.match(/^\s*(`{3,}|~{3,})/);
    if (marker) {
      if (fence === null) fence = marker[1][0];
      else if (marker[1][0] === fence) fence = null;
    }
    const heading = fence === null && line.match(/^(#{1,6})\s+(.+?)(?:\s+#+)?\s*$/);
    if (heading) {
      const base = slugify(heading[2]);
      const count = seen.get(base) ?? 0;
      seen.set(base, count + 1);
      current = {
        heading: heading[2],
        level: heading[1].length,
        anchor: count === 0 ? base : `${base}-${count}`,
        lines: [],
      };
      sections.push(current);
    } else if (current) {
      current.lines.push(line);
    }
  }
  return sections.map(({ lines, ...section }) => ({ ...section, text: lines.join('\n').trim() }));
}

const INTRO = `# tmuxy

> A web and desktop interface for tmux: a React frontend and a Rust backend
> that drives tmux over control mode. The same UI runs in a browser tab
> (\`tmuxy server\`) and in the desktop app (Tauri).

This file is every document in the repository's docs/ directory, for agents.
Each one starts under a header naming its canonical URL; links between docs
point there too. The same docs, one entry per section, are in
${SITE}/search.json: fetch it once and filter it yourself.

Before changing the code, read AGENTS.md at the repository root:
${canonicalUrl('AGENTS.md')}
Two rules from it matter most: every tmux command goes through the
control-mode connection, never a separate \`tmux\` process, and the UI never
writes a tmux command string outside \`toTmuxCommand\`.

Source: https://github.com/flplima/tmuxy
`;

const RULE = '='.repeat(72);

/** Every .md file in the docs directory, the guide (README.md) first. */
export function readDocs(docsDir) {
  const names = readdirSync(docsDir)
    .filter((name) => name.endsWith('.md'))
    .sort((a, b) => (a === 'README.md' ? -1 : b === 'README.md' ? 1 : a.localeCompare(b)));
  return names.map((name) => ({
    path: `docs/${name}`,
    markdown: readFileSync(join(docsDir, name), 'utf8'),
  }));
}

/** The text of /llms-full.txt. */
export function buildLlmsFull(docs) {
  const parts = docs.map(({ path, markdown }) =>
    [RULE, path, canonicalUrl(path), RULE, '', absolutizeLinks(markdown, path).trim(), ''].join(
      '\n',
    ),
  );
  return [INTRO, ...parts].join('\n');
}

/** The value of /search.json. */
export function buildSearchIndex(docs) {
  return {
    about: `tmuxy's docs, one entry per section. Every doc in one file: ${SITE}/llms-full.txt`,
    sections: docs.flatMap(({ path, markdown }) =>
      splitSections(absolutizeLinks(markdown, path)).map(({ heading, level, anchor, text }) => ({
        doc: path,
        heading,
        level,
        url: `${canonicalUrl(path)}#${anchor}`,
        text,
      })),
    ),
  };
}

/** Writes both files into the site's public/ directory. */
export function writeAgentDocs(docsDir, publicDir) {
  const docs = readDocs(docsDir);
  mkdirSync(publicDir, { recursive: true });
  writeFileSync(join(publicDir, 'llms-full.txt'), buildLlmsFull(docs));
  writeFileSync(join(publicDir, 'search.json'), JSON.stringify(buildSearchIndex(docs)));
  return docs.length;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const here = dirname(fileURLToPath(import.meta.url));
  const count = writeAgentDocs(join(here, '..', '..', '..', 'docs'), join(here, '..', 'public'));
  console.log(`agent docs: ${count} docs into public/llms-full.txt and public/search.json`);
}
