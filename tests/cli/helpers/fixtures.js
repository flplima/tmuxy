/**
 * Canned tmux output for --json formatting tests.
 */

// list-panes format: #{pane_id},#{window_id},#{pane_width},#{pane_height},#{pane_current_command},#{pane_active}
const LIST_PANES_OUTPUT = ['%0,@0,120,40,zsh,1', '%1,@0,80,30,vim,0'].join('\n');

const LIST_PANES_JSON = [
  { id: '%0', tab: '@0', width: 120, height: 40, command: 'zsh', active: true },
  { id: '%1', tab: '@0', width: 80, height: 30, command: 'vim', active: false },
];

// list-windows format: #{window_id},#{window_index},#{window_name},#{window_panes},#{window_active},#{@tmuxy-window-type}
const LIST_WINDOWS_OUTPUT = ['@0,0,main,2,1,tab', '@1,1,editor,1,0,tab'].join('\n');

const LIST_WINDOWS_JSON = [
  { id: '@0', index: 0, name: 'main', panes: 2, active: true },
  { id: '@1', index: 1, name: 'editor', panes: 1, active: false },
];

// A session that also contains tmuxy's hidden windows — float, group, and the
// sidebar. `tmuxy tab list --json` must drop those, keeping only the two tabs.
const LIST_WINDOWS_WITH_HIDDEN_OUTPUT = [
  '@0,0,main,2,1,tab',
  '@1,1,editor,1,0,tab',
  '@2,2,float,1,0,float',
  '@3,3,__group_x,1,0,group',
  '@4,4,__sidebar,1,0,sidebar',
].join('\n');

module.exports = {
  LIST_PANES_OUTPUT,
  LIST_PANES_JSON,
  LIST_WINDOWS_OUTPUT,
  LIST_WINDOWS_JSON,
  LIST_WINDOWS_WITH_HIDDEN_OUTPUT,
};
