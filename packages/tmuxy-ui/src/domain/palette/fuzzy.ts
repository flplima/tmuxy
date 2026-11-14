/**
 * The palette's fuzzy match: the letters of the query, in order, anywhere in
 * the text. A match scores higher the more its letters run together and the
 * more of them start a word, so "sp" finds "Split Pane" before "Swap", and
 * "nt" finds "New Tab" before "Next".
 */

export interface FuzzyMatch {
  score: number;
  /** The indices of `text` the query's letters landed on, ascending. */
  positions: number[];
}

const MATCH = 1;
const CONSECUTIVE = 1.2;
const WORD_START = 0.9;
const CAMEL = 0.7;
const FIRST_LETTER = 1;
const GAP_LEADING = 0.005;
const GAP_INNER = 0.012;
const MAX_TEXT = 256;

const SEPARATOR = /[\s\-_/.:,›>()[\]"'@#]/;

/** What a letter is worth for where it sits: the first one, a word's start, a camelCase hump. */
function bonusAt(text: string, index: number): number {
  if (index === 0) return FIRST_LETTER;
  const before = text[index - 1];
  if (SEPARATOR.test(before)) return WORD_START;
  const here = text[index];
  if (before === before.toLowerCase() && here !== here.toLowerCase()) return CAMEL;
  return 0;
}

/** `best` and `ending` of the scoring table (see `scoreTable`). */
interface ScoreTable {
  best: number[][];
  ending: number[][];
}

/**
 * The scores of every way to lay `needle` over `hay`, both already lowered
 * for the comparison (`hay` as written decides the bonuses):
 * `best[i][j]` is the best score with needle[0..i] matched inside hay[0..j],
 * `ending[i][j]` the same with needle[i] landing exactly on hay[j].
 */
function scoreTable(lowerNeedle: string, lowerHay: string, hay: string): ScoreTable {
  const n = lowerNeedle.length;
  const m = hay.length;
  const best: number[][] = [];
  const ending: number[][] = [];
  for (let i = 0; i < n; i++) {
    best.push(new Array<number>(m).fill(-Infinity));
    ending.push(new Array<number>(m).fill(-Infinity));
    // What follows the last letter costs nothing: a match is not worse for
    // the text being longer. `rank` breaks such ties itself, so a row it
    // must not put first cannot win one by having the shortest label.
    const gap = i === n - 1 ? 0 : GAP_INNER;
    let running = -Infinity;
    for (let j = i; j < m; j++) {
      if (lowerNeedle[i] !== lowerHay[j]) {
        running -= gap;
      } else {
        const score =
          i === 0
            ? MATCH + bonusAt(hay, j) - j * GAP_LEADING
            : Math.max(
                best[i - 1][j - 1] + MATCH + bonusAt(hay, j),
                ending[i - 1][j - 1] + MATCH + CONSECUTIVE,
              );
        ending[i][j] = score;
        running = Math.max(score, running - gap);
      }
      best[i][j] = running;
    }
  }
  return { best, ending };
}

/**
 * Where the best match put each letter, walking the table back from its
 * end: a letter sits where its `ending` score is the row's best, and once
 * one is taken as a consecutive match the one before it is taken at the cell
 * before.
 */
function matchedPositions({ best, ending }: ScoreTable): number[] {
  const n = best.length;
  const positions = new Array<number>(n);
  let required = false;
  let j = best[0].length - 1;
  for (let i = n - 1; i >= 0; i--) {
    for (; j >= 0; j--) {
      const here = ending[i][j];
      if (here === -Infinity || !(required || here === best[i][j])) continue;
      required = i > 0 && j > 0 && best[i][j] === ending[i - 1][j - 1] + MATCH + CONSECUTIVE;
      positions[i] = j--;
      break;
    }
  }
  return positions;
}

/**
 * `needle` matched against `text`, ignoring case; null when its letters are
 * not all there in order. An empty needle matches everything with score 0.
 */
export function fuzzyMatch(needle: string, text: string): FuzzyMatch | null {
  if (needle === '') return { score: 0, positions: [] };
  const hay = text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) : text;
  if (needle.length > hay.length) return null;
  const table = scoreTable(needle.toLowerCase(), hay.toLowerCase(), hay);
  const score = table.best[needle.length - 1][hay.length - 1];
  if (score === -Infinity) return null;
  return { score, positions: matchedPositions(table) };
}

export interface Searchable {
  /** What the row shows, and where the matched letters are marked. */
  label: string;
  /** What is not on the row's main line but should still find it: its menu, other names for it. */
  extra?: string;
  /** Never ahead of an equal match that lacks it (a row that ends something). */
  last?: boolean;
}

export interface Ranked<T> {
  item: T;
  score: number;
  /** The label's matched letters; empty where a word matched `extra` alone. */
  positions: number[];
}

/** What a word found only in `extra` is worth beside one found in the label. */
const EXTRA_WEIGHT = 0.5;

/** One word of the query against one item: its score and the label letters it took, or null. */
function wordMatch(item: Searchable, word: string): { score: number; positions: number[] } | null {
  const inLabel = fuzzyMatch(word, item.label);
  const inExtra = item.extra ? fuzzyMatch(word, item.extra) : null;
  const extraScore = inExtra ? inExtra.score * EXTRA_WEIGHT : -Infinity;
  if (inLabel && inLabel.score >= extraScore) return inLabel;
  return inExtra ? { score: extraScore, positions: [] } : null;
}

/**
 * `items` that match every word of `query`, best first. Between equal
 * matches, one marked `last` comes after one that is not; then the shorter
 * label (the query covers more of it), unless both are `last`, which keep
 * the order they came in; then that order. An empty query keeps them all, in
 * order.
 */
export function rank<T extends Searchable>(items: readonly T[], query: string): Ranked<T>[] {
  const words = query.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return items.map((item) => ({ item, score: 0, positions: [] }));
  const out: Array<Ranked<T> & { order: number }> = [];
  items.forEach((item, order) => {
    let score = 0;
    const positions = new Set<number>();
    for (const word of words) {
      const match = wordMatch(item, word);
      if (!match) return;
      score += match.score;
      for (const p of match.positions) positions.add(p);
    }
    out.push({ item, score, positions: [...positions].sort((a, b) => a - b), order });
  });
  const tieBreak = (a: T, b: T) =>
    Number(Boolean(a.last)) - Number(Boolean(b.last)) ||
    (a.last ? 0 : a.label.length - b.label.length);
  out.sort((a, b) => b.score - a.score || tieBreak(a.item, b.item) || a.order - b.order);
  return out.map(({ item, score, positions }) => ({ item, score, positions }));
}
