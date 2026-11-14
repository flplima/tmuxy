/**
 * Which items a pane's row in the sidebar tree shows, on which lines: the
 * `@tmuxy-tree-row` option, set in `tmuxy.conf`.
 *
 *   set -g @tmuxy-tree-row 'process ports id / cwd branch / title / fields'
 *
 * Lines are separated by `/`, items within a line by spaces. A line whose
 * items have nothing to show is left out, so a pane with no title has no
 * title line. A template with a word this does not know is not used at all
 * (the default is), rather than drawn without the item that was meant.
 */

export type RowItem =
  | { kind: 'process' }
  | { kind: 'ports' }
  | { kind: 'id' }
  | { kind: 'cwd' }
  | { kind: 'branch' }
  | { kind: 'title' }
  | { kind: 'fields' }
  | { kind: 'field'; key: string };

export type RowTemplate = readonly (readonly RowItem[])[];

const WORDS = ['process', 'ports', 'id', 'cwd', 'branch', 'title', 'fields'] as const;
const FIELD_KEY = /^[a-z][a-z0-9_-]{0,23}$/;
const MAX_LINES = 6;

export const DEFAULT_ROW_TEMPLATE: RowTemplate = [
  [{ kind: 'process' }, { kind: 'ports' }, { kind: 'id' }],
  [{ kind: 'cwd' }, { kind: 'branch' }],
  [{ kind: 'title' }],
  [{ kind: 'fields' }],
];

function item(word: string): RowItem | null {
  if ((WORDS as readonly string[]).includes(word)) return { kind: word } as RowItem;
  const key = word.startsWith('field:') ? word.slice('field:'.length) : null;
  return key !== null && FIELD_KEY.test(key) ? { kind: 'field', key } : null;
}

/**
 * The template in an option's value, or `null` when it is empty or holds a
 * word this does not know, an empty line, an item twice, or more than six
 * lines: the default is drawn then.
 */
export function parseRowTemplate(option: string): RowTemplate | null {
  const text = option.trim();
  if (!text) return null;
  const lines = text.split('/').map((line) => line.trim().split(/\s+/).filter(Boolean));
  if (lines.length > MAX_LINES || lines.some((line) => line.length === 0)) return null;
  const words = lines.flat();
  if (new Set(words).size !== words.length) return null;
  const template = lines.map((line) => line.map(item));
  return template.every((line) => line.every((it) => it !== null))
    ? (template as RowItem[][])
    : null;
}
