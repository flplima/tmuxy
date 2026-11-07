/**
 * What tmux holds for one pane or window, read-only (safe beside control
 * mode): the ground truth a test compares the screen with.
 */

const { tmuxExec } = require('./tmux-socket');

const PANE_FIELDS = {
  id: '#{pane_id}',
  windowId: '#{window_id}',
  width: '#{pane_width}',
  height: '#{pane_height}',
  left: '#{pane_left}',
  top: '#{pane_top}',
  active: '#{pane_active}',
  inMode: '#{pane_in_mode}',
  title: '#{pane_title}',
  command: '#{pane_current_command}',
};

const WINDOW_FIELDS = {
  id: '#{window_id}',
  index: '#{window_index}',
  width: '#{window_width}',
  height: '#{window_height}',
  zoomed: '#{window_zoomed_flag}',
  type: '#{@tmuxy-window-type}',
  name: '#{window_name}',
};

const NUMBERS = new Set(['width', 'height', 'left', 'top', 'index']);
const FLAGS = new Set(['active', 'inMode', 'zoomed']);

function read(fields, target) {
  const sep = '\u001f';
  const keys = Object.keys(fields);
  const out = tmuxExec(
    `display-message -p -t '${target}' '${keys.map((k) => fields[k]).join(sep)}'`,
  ).split(sep);
  return Object.fromEntries(
    keys.map((k, i) => [
      k,
      NUMBERS.has(k) ? Number(out[i]) : FLAGS.has(k) ? out[i] === '1' : out[i] || null,
    ]),
  );
}

/** One pane as tmux has it (`%3`). */
const tmuxPane = (paneId) => read(PANE_FIELDS, paneId);

/** One window as tmux has it (`@2`, or a pane in it). */
const tmuxWindow = (target) => read(WINDOW_FIELDS, target);

/** Every pane of a window (`@2`) or a session, as tmux has them. */
function tmuxPanes(target, { session = false } = {}) {
  const sep = '\u001f';
  const keys = Object.keys(PANE_FIELDS);
  return tmuxExec(
    `list-panes ${session ? '-s ' : ''}-t '${target}' -F '${keys.map((k) => PANE_FIELDS[k]).join(sep)}'`,
  )
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const out = line.split(sep);
      return Object.fromEntries(
        keys.map((k, i) => [
          k,
          NUMBERS.has(k) ? Number(out[i]) : FLAGS.has(k) ? out[i] === '1' : out[i] || null,
        ]),
      );
    });
}

module.exports = { tmuxPane, tmuxWindow, tmuxPanes };
