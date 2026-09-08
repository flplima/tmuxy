/**
 * Shared pane tab display helpers — the process icon and title shown for a pane.
 *
 * Used by both the pane header tabs (`PaneHeader`) and the sidebar tree
 * (`SidebarTree`) so a pane reads with the identical icon + title everywhere.
 */

import type { TmuxPane } from '../tmux/types';
import { getWidget } from './widgets';

const PROCESS_ICONS: Record<string, string> = {
  zsh: '\ue795', //  nf-custom-terminal
  bash: '\ue795', //  nf-custom-terminal
  fish: '\ue795', //  nf-custom-terminal
  sh: '\ue795', //  nf-custom-terminal
  vi: '\ue62b', //  nf-seti-vim
  vim: '\ue62b', //  nf-seti-vim
  nvim: '\ue62b', //  nf-seti-vim
  docker: '\u{f0868}', // 󰡨 nf-md-docker
  node: '\ue718', //  nf-dev-nodejs_small
  python: '\ue73c', //  nf-dev-python
  python3: '\ue73c', //  nf-dev-python
  cargo: '\ue7a8', //  nf-dev-rust
  rustc: '\ue7a8', //  nf-dev-rust
  git: '\ue702', //  nf-dev-git
  ssh: '\uf489', //  nf-oct-server
  htop: '\uf080', //  nf-fa-bar_chart
  top: '\uf080', //  nf-fa-bar_chart
  man: '\uf02d', //  nf-fa-book
  less: '\uf02d', //  nf-fa-book
  npm: '\ue71e', //  nf-dev-npm
  make: '\ue779', //  nf-dev-gnu
  gcc: '\ue779', //  nf-dev-gnu
  go: '\ue626', //  nf-seti-go
  lua: '\ue620', //  nf-seti-lua
  ruby: '\ue739', //  nf-dev-ruby
  tmux: '\ue795', //  nf-custom-terminal
};

const DEFAULT_ICON = '\ue795'; //  nf-custom-terminal

function getProcessIcon(command: string): string {
  const name = command.toLowerCase();
  if (PROCESS_ICONS[name]) return PROCESS_ICONS[name];
  if (name.includes('docker')) return PROCESS_ICONS.docker;
  return DEFAULT_ICON;
}

/**
 * Process/widget icon for a pane. A widget's own icon comes from its
 * registered definition (components/widgets), so adding a widget never means
 * editing a table here.
 */
export function getTabIcon(pane: TmuxPane, widgetName?: string): string | null {
  const widgetIcon = widgetName ? getWidget(widgetName)?.icon : undefined;
  if (widgetIcon) return widgetIcon;
  if (pane.command) return getProcessIcon(pane.command);
  return null;
}

/**
 * Tab/title text for a pane.
 *
 * The app's own title wins: `pane.title` carries what the running program
 * announced over OSC 0/2 (`claude`, `nvim README.md`, an ssh host), and the
 * backend already blanks it when tmux's default host-name seed is all that is
 * there — so a non-empty value always means an app set it. `pane.command` is
 * only the executable's file name, which can be meaningless on its own (a
 * version-pinned launcher symlink reports e.g. `2.1.251`), so it is the
 * fallback rather than the first choice.
 */
export function getTabText(pane: TmuxPane, titleOverride?: string): string {
  if (pane.inMode) return '[COPY MODE]';
  if (titleOverride) return titleOverride;
  return pane.title || pane.command || pane.borderTitle.trim() || 'shell';
}
