'use client';

/**
 * tmuxy.sh/plugins: the plugin index, read from the `plugin-index` branch,
 * where .github/workflows/plugin-index.yml publishes it every six hours.
 *
 * The page lists what the index lists and nothing more. The index is a
 * convenience, not a trust signal: the page says so, and `tmuxy plugin
 * install` shows what a plugin can do and asks before installing it.
 */

import { useEffect, useMemo, useState } from 'react';

const INDEX_URL = 'https://raw.githubusercontent.com/flplima/tmuxy/plugin-index/plugins.json';

interface Entry {
  name: string;
  description: string;
  source: string;
  stars: number;
  updated: string;
  capabilities: string[];
  platforms: string[];
  duplicate?: boolean;
}

type Load = { kind: 'loading' } | { kind: 'failed' } | { kind: 'ready'; plugins: Entry[] };

/** The repository part of `owner/repo[/subdir]`. */
const repoOf = (source: string) => source.split('/').slice(0, 2).join('/');

export default function Plugins() {
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [query, setQuery] = useState('');

  useEffect(() => {
    fetch(INDEX_URL, { mode: 'cors' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((index: { plugins?: Entry[] }) =>
        setLoad({ kind: 'ready', plugins: index.plugins ?? [] }),
      )
      .catch(() => setLoad({ kind: 'failed' }));
  }, []);

  const shown = useMemo(() => {
    if (load.kind !== 'ready') return [];
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return load.plugins.filter((p) => {
      const hay = `${p.name} ${p.description} ${p.source}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  }, [load, query]);

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 px-4 py-10">
      <header className="flex flex-col gap-2">
        <h1 className="text-3xl font-bold" style={{ color: 'var(--accent-green)' }}>
          <a href="/">tmuxy</a> plugins
        </h1>
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
          Every public GitHub repository with the topic <code>tmuxy-plugin</code> whose manifest
          passes <code>tmuxy plugin check</code>, refreshed every six hours. Listing here is not a
          review: a plugin&apos;s commands run as you, with every pane in reach.{' '}
          <code>tmuxy plugin install</code> shows what a plugin can do and asks first.
        </p>
      </header>

      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search plugins"
        aria-label="Search plugins"
        className="w-full rounded px-3 py-2 text-sm"
        style={{
          background: 'var(--bg-secondary)',
          color: 'var(--text-primary)',
          border: '1px solid var(--border-primary)',
        }}
      />

      {load.kind === 'loading' && <p style={{ color: 'var(--text-muted)' }}>Loading the index…</p>}
      {load.kind === 'failed' && (
        <p style={{ color: 'var(--text-muted)' }}>
          The index could not be loaded. <code>tmuxy plugin search</code> reads the same one.
        </p>
      )}
      {load.kind === 'ready' && shown.length === 0 && (
        <p style={{ color: 'var(--text-muted)' }}>No plugin matches.</p>
      )}

      <ul className="flex flex-col gap-4" data-testid="plugin-list">
        {shown.map((p) => (
          <li
            key={p.source}
            className="flex flex-col gap-1 rounded p-4"
            style={{ border: '1px solid var(--border-primary)' }}
          >
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>
                {p.name}
              </h2>
              <a
                href={`https://github.com/${repoOf(p.source)}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs underline"
                style={{ color: 'var(--text-muted)' }}
              >
                {p.source} · ★ {p.stars}
              </a>
            </div>
            {p.description && (
              <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                {p.description}
              </p>
            )}
            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
              {[...p.capabilities, ...(p.platforms.length ? [p.platforms.join('/')] : [])].join(
                ' · ',
              )}
            </p>
            <code className="text-sm" style={{ color: 'var(--accent-green)' }}>
              tmuxy plugin install {p.duplicate ? p.source : p.name}
            </code>
          </li>
        ))}
      </ul>
    </main>
  );
}
