/**
 * A pane's custom fields (`tmuxy pane meta`), read from the `@tmuxy-meta`
 * option the sessions poll lists with each pane: base64 of a JSON object
 * of `{ v, until? }` by key. The rules are core's (`tmuxy-core/src/
 * pane_meta.rs`); the option is writable by anything on the socket, so a
 * value that breaks them is shown as nothing, and a field past its time is
 * left out.
 */

export interface PaneField {
  key: string;
  value: string;
}

const MAX_FIELDS = 8;
const MAX_VALUE_CHARS = 80;
const KEY = /^[a-z][a-z0-9_-]{0,23}$/;
const CONTROL = /\p{Cc}/u;

function decodeBase64(text: string): string | null {
  try {
    const bytes = Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function isField(value: unknown): value is { v: string; until?: number } {
  if (typeof value !== 'object' || value === null) return false;
  const { v, until } = value as { v?: unknown; until?: unknown };
  return (
    typeof v === 'string' &&
    v.length > 0 &&
    v === v.trim() &&
    [...v].length <= MAX_VALUE_CHARS &&
    !CONTROL.test(v) &&
    (until === undefined || typeof until === 'number')
  );
}

/** The fields an option's value holds that are shown at `nowSeconds`, in key order. */
export function paneFields(option: string, nowSeconds: number): PaneField[] {
  const text = option.trim() ? decodeBase64(option.trim()) : null;
  if (!text) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return [];
  const entries = Object.entries(parsed);
  if (entries.length > MAX_FIELDS) return [];
  if (!entries.every(([key, field]) => KEY.test(key) && isField(field))) return [];
  return entries
    .filter(
      ([, field]) =>
        (field as { until?: number }).until === undefined ||
        (field as { until: number }).until > nowSeconds,
    )
    .map(([key, field]) => ({ key, value: (field as { v: string }).v }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}
