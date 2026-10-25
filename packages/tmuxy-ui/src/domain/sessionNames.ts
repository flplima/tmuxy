/**
 * The name a session gets when the user gives it none: an adjective and a
 * noun, `drifting-cedar`, rather than a timestamp. The word lists are
 * the CLI's (`tmuxy-cli/bin/tmuxy/session-names.json`), which
 * `memorable_session_name` in `bin/tmuxy/_lib` draws from the same way, so a
 * session made from the menu and one made from `tmuxy session switch` look
 * alike.
 */

import words from '../../../tmuxy-cli/bin/tmuxy/session-names.json';

const { adjectives, nouns } = words;
const PAIRS = adjectives.length * nouns.length;

const pair = (index: number) =>
  `${adjectives[Math.floor(index / nouns.length)]}-${nouns[index % nouns.length]}`;

/**
 * A name no session in `taken` has. The pairs are tried from a random one
 * onward, so a number is added only once every pair is taken.
 */
export function memorableSessionName(
  taken: Iterable<string>,
  random: () => number = Math.random,
): string {
  const used = new Set(taken);
  const start = Math.floor(random() * PAIRS) % PAIRS;
  for (let i = 0; i < PAIRS; i++) {
    const name = pair((start + i) % PAIRS);
    if (!used.has(name)) return name;
  }
  const base = pair(start);
  let n = 2;
  while (used.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}
