/**
 * What tmux holds for its panes and windows, read-only (safe beside control
 * mode): the ground truth a test compares the screen with. Every reader of
 * tmux's state in the harness goes through these, so a field reads the same
 * way everywhere.
 */

const { tmuxExec } = require('./tmux-socket');

const PANE_FIELDS = {
  id: '#{pane_id}',
  index: '#{pane_index}',
  windowId: '#{window_id}',
  width: '#{pane_width}',
  height: '#{pane_height}',
  left: '#{pane_left}',
  top: '#{pane_top}',
  active: '#{pane_active}',
  inMode: '#{pane_in_mode}',
  alternate: '#{alternate_on}',
  title: '#{pane_title}',
  command: '#{pane_current_command}',
};

const WINDOW_FIELDS = {
  id: '#{window_id}',
  index: '#{window_index}',
  width: '#{window_width}',
  height: '#{window_height}',
  active: '#{window_active}',
  zoomed: '#{window_zoomed_flag}',
  type: '#{@tmuxy-window-type}',
  parent: '#{@tmuxy-float-parent}',
  name: '#{window_name}',
};

const NUMBERS = new Set(['width', 'height', 'left', 'top', 'index']);
const FLAGS = new Set(['active', 'inMode', 'alternate', 'zoomed']);
const SEP = '\u001f';
// tmux 3.4 prints the separator back as the four characters `\037`; later
// releases pass the byte through.
const PRINTED_SEP = /\u001f|\\037/;

const format = (fields) => Object.values(fields).join(SEP);

function parse(fields, line) {
  const out = line.split(PRINTED_SEP);
  const row = Object.fromEntries(
    Object.keys(fields).map((k, i) => [
      k,
      NUMBERS.has(k) ? Number(out[i]) : FLAGS.has(k) ? out[i] === '1' : out[i] || null,
    ]),
  );
  // Tabs are the untagged windows (docs/TMUX-TAGS.md).
  if ('type' in row) row.type ??= 'tab';
  return row;
}

const list = (command, fields) =>
  tmuxExec(`${command} -F '${format(fields)}'`)
    .split('\n')
    .filter(Boolean)
    .map((line) => parse(fields, line));

/** One pane as tmux has it (`%3`). */
const tmuxPane = (paneId) =>
  parse(PANE_FIELDS, tmuxExec(`display-message -p -t '${paneId}' '${format(PANE_FIELDS)}'`));

/** One window as tmux has it (`@2`, or a pane in it). */
const tmuxWindow = (target) =>
  parse(WINDOW_FIELDS, tmuxExec(`display-message -p -t '${target}' '${format(WINDOW_FIELDS)}'`));

/** Every pane of a window (`@2`) or a session, as tmux has them. */
const tmuxPanes = (target, { session = false } = {}) =>
  list(`list-panes ${session ? '-s ' : ''}-t '${target}'`, PANE_FIELDS);

/** Every window of a session, as tmux has them. */
const tmuxWindows = (session) => list(`list-windows -t '${session}'`, WINDOW_FIELDS);

module.exports = { tmuxPane, tmuxWindow, tmuxPanes, tmuxWindows };
