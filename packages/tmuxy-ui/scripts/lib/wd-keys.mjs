/**
 * W3C WebDriver key codes, and the translation from the key names the shared
 * interaction suite presses.
 *
 * The suite speaks Playwright's spelling (`'a'`, `'Control+ArrowRight'`);
 * WebDriver wants characters from the Unicode private-use block. They are
 * written as numbers: the characters are invisible in an editor, and an escape
 * sequence is one careless re-encode away from becoming one.
 *
 * The block is contiguous and the arrows sit right after Home/End, so they are
 * easy to get wrong. The W3C WebDriver table, in order, is the authority:
 *
 *     E00E PageUp   E00F PageDown   E010 End     E011 Home
 *     E012 Left     E013 Up         E014 Right   E015 Down
 */
const wdKey = (codePoint) => String.fromCharCode(codePoint);

export const WD_KEYS = {
  Enter: wdKey(0xe007),
  Tab: wdKey(0xe004),
  Escape: wdKey(0xe00c),
  Backspace: wdKey(0xe003),
  ArrowUp: wdKey(0xe013),
  ArrowDown: wdKey(0xe015),
  ArrowLeft: wdKey(0xe012),
  ArrowRight: wdKey(0xe014),
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
