/**
 * W3C WebDriver key codes, and the translation from the key names the shared
 * interaction suite presses.
 *
 * The suite speaks Playwright's spelling (`'a'`, `'Control+ArrowRight'`)
 * because that is what the web harness needs; WebDriver wants the characters
 * from the Unicode private-use block instead. Keeping the mapping here stops a
 * second key vocabulary leaking into `perf-harness.mjs`.
 *
 * The codepoints are written as numbers and resolved with `fromCharCode`
 * rather than spelled as string escapes: the characters themselves are
 * invisible in an editor, and an escape sequence is one careless re-encode
 * away from becoming one. A number survives both.
 */
const wdKey = (codePoint) => String.fromCharCode(codePoint);

export const WD_KEYS = {
  Enter: wdKey(0xe007),
  Tab: wdKey(0xe004),
  Escape: wdKey(0xe00c),
  Backspace: wdKey(0xe003),
  ArrowUp: wdKey(0xe013),
  ArrowDown: wdKey(0xe014),
  ArrowLeft: wdKey(0xe012),
  ArrowRight: wdKey(0xe011),
  Control: wdKey(0xe009),
  Shift: wdKey(0xe008),
  Alt: wdKey(0xe00a),
  Meta: wdKey(0xe03d),
};

/**
 * `'Control+ArrowRight'` becomes the two-element chord WebdriverIO sends with
 * the modifier held. A part with no mapping is passed through as its own
 * literal, which is what makes a plain letter work.
 */
export const toChord = (key) => key.split('+').map((part) => WD_KEYS[part] ?? part);
