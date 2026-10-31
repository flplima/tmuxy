/**
 * Other people's text — an advisory, a CodeQL message, a CI log — made safe to
 * put in a prompt for the Copilot agent (bin/ci/sunday-sweep.mjs).
 *
 * What a person reviewing the prompt sees has to be all the agent reads, so
 * everything that hides text goes: terminal escape sequences (a log is full of
 * colour codes, and an OSC or DCS string is invisible in a terminal), control
 * characters, and the invisible Unicode a model still reads — format
 * characters (zero-width, bidi overrides, the U+E0000 tag block that spells
 * ASCII invisibly) and variation selectors, which can carry a byte each.
 */

/** C1 controls written as one code point (U+0080–U+009F) are ESC + (code − 0x40). */
const C1 = /[\u0080-\u009f]/g;
const ESCAPE_SEQUENCE = new RegExp(
  [
    // CSI runs to its final byte, 0x40–0x7e.
    '\\x1b\\[[^\\x40-\\x7e]*[\\x40-\\x7e]?',
    // OSC, DCS, SOS, PM and APC are strings, ended by BEL or ST (ESC \) — or
    // by nothing, in which case a terminal hides the rest and so does this.
    '\\x1b[\\]PX^_][\\s\\S]*?(?:\\x07|\\x1b\\\\|$)',
    // Every other escape: intermediates, then one final byte.
    '\\x1b[\\x20-\\x2f]*[\\x30-\\x7e]?',
  ].join('|'),
  'g',
);
/** Controls but newline and tab, format characters, the tag block, lone surrogates, variation selectors. */
const HIDDEN =
  /[^\P{Cc}\n\t]|\p{Cf}|[\u{E0000}-\u{E007F}]|\p{Cs}|[\ufe00-\ufe0f\u{E0100}-\u{E01EF}]/gu;

/** `text` as it reads on screen: no escape sequences and nothing invisible. */
export const withoutControls = (text) =>
  String(text ?? '')
    .replace(C1, (c) => '\x1b' + String.fromCharCode(c.charCodeAt(0) - 0x40))
    .replace(ESCAPE_SEQUENCE, '')
    .replace(/[\u2028\u2029]/g, '\n')
    .replace(HIDDEN, '');

/**
 * Text fenced so it reads as data: nothing hidden, no run of backticks or
 * tildes long enough to close the fence or open another, and no leading `#`
 * to pass for a heading of the prompt.
 */
export const fenced = (text, max = 4000) =>
  '```text\n' +
  withoutControls(text)
    .replace(/[`~]{3,}/g, (run) => "'".repeat(run.length))
    .replace(/^(\s*)#/gm, '$1\\#')
    .slice(0, max) +
  '\n```';

/**
 * A short field — a package name, a version range, a path — for a backtick
 * code span inside a line of the prompt: one line, no backtick to end the
 * span early, nothing hidden, and capped.
 */
export const inline = (text, max = 200) =>
  withoutControls(text).replace(/\s+/g, ' ').replace(/`/g, "'").trim().slice(0, max);
