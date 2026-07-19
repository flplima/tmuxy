/**
 * Canned tmux output for --json formatting tests.
 */

// list-panes format is TAB-separated (free-text fields may contain commas):
// #{pane_id}\t#{window_id}\t#{pane_width}\t#{pane_height}\t#{pane_current_command}\t#{pane_active}
const LIST_PANES_OUTPUT = ['%0\t@0\t120\t40\tzsh\t1', '%1\t@0\t80\t30\tvim\t0'].join('\n');

const LIST_PANES_JSON = [
  { id: '%0', tab: '@0', width: 120, height: 40, command: 'zsh', active: true },
  { id: '%1', tab: '@0', width: 80, height: 30, command: 'vim', active: false },
];

// list-windows format is TAB-separated (window_name is user-controlled):
// #{window_id}\t#{window_index}\t#{window_name}\t#{window_panes}\t#{window_active}\t#{@tmuxy-window-type}
const LIST_WINDOWS_OUTPUT = ['@0\t0\tmain\t2\t1\ttab', '@1\t1\teditor\t1\t0\ttab'].join('\n');

const LIST_WINDOWS_JSON = [
  { id: '@0', index: 0, name: 'main', panes: 2, active: true },
  { id: '@1', index: 1, name: 'editor', panes: 1, active: false },
];

// A session that also contains tmuxy's hidden windows — float, group, and the
// sidebar. `tmuxy tab list --json` must drop those, keeping only the two tabs.
const LIST_WINDOWS_WITH_HIDDEN_OUTPUT = [
  '@0\t0\tmain\t2\t1\ttab',
  '@1\t1\teditor\t1\t0\ttab',
  '@2\t2\tfloat\t1\t0\tfloat',
  '@3\t3\t__group_x\t1\t0\tgroup',
  '@4\t4\t__sidebar\t1\t0\tsidebar',
].join('\n');

// A window name carrying the characters that broke the old comma-joined,
// unescaped serializer: a comma (field shift) and a double quote (invalid JSON).
const LIST_WINDOWS_HOSTILE_OUTPUT = ['@0\t0\tbuild, "test"\t2\t1\ttab'].join('\n');

module.exports = {
  LIST_PANES_OUTPUT,
  LIST_PANES_JSON,
  LIST_WINDOWS_OUTPUT,
  LIST_WINDOWS_JSON,
  LIST_WINDOWS_WITH_HIDDEN_OUTPUT,
  LIST_WINDOWS_HOSTILE_OUTPUT,
};
