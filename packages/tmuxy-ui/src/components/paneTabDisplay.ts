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

/**
 * Below this, a character is ordinary text: ASCII, Latin, and the punctuation
 * blocks that hold quotation marks, dashes and the like. Above it are the
 * arrows, geometric shapes, dingbats, emoji and private-use icon fonts an
 * application might lead its title with.
 */
const FIRST_SYMBOL_CODEPOINT = 0x2070;

function getProcessIcon(command: string): string {
  const name = command.toLowerCase();
  if (PROCESS_ICONS[name]) return PROCESS_ICONS[name];
  if (name.includes('docker')) return PROCESS_ICONS.docker;
  return DEFAULT_ICON;
}

/**
 * The icon an application put at the front of its own title, if it did.
 *
 * Plenty of them do — Claude Code announces `\u273b claude`, and the pattern is
 * a symbol, a space, then the title. Drawing our guess at a process icon
 * beside it gives the pane two icons, one of which is wrong, so the app's own
 * wins: it knows what it is better than a table of executable names does.
 *
 * The test is deliberately narrow. A leading symbol only counts when a space
 * follows it, because that is what makes it a prefix rather than the first
 * character of a word, and only characters above the punctuation blocks count
 * at all — a title starting with a quotation mark or a dash is a title, not an
 * icon.
 */
export function splitTitleIcon(text: string): { icon: string | null; text: string } {
  const first = text.codePointAt(0);
  if (first === undefined || first < FIRST_SYMBOL_CODEPOINT) return { icon: null, text };
  let end = String.fromCodePoint(first).length;
  // An emoji presentation selector belongs to the glyph before it.
  if (text.codePointAt(end) === 0xfe0f) end += 1;
  if (text[end] !== ' ') return { icon: null, text };
  const rest = text.slice(end + 1).trim();
  return rest ? { icon: text.slice(0, end), text: rest } : { icon: null, text };
}

/**
 * Process/widget icon for a pane. A widget's own icon comes from its
 * registered definition (components/widgets), so adding a widget never means
 * editing a table here; an application's own icon comes from its title.
 */
export function getTabIcon(
  pane: TmuxPane,
  widgetName?: string,
  titleOverride?: string,
): string | null {
  const widgetIcon = widgetName ? getWidget(widgetName)?.icon : undefined;
  if (widgetIcon) return widgetIcon;
  const own = splitTitleIcon(getTabText(pane, titleOverride)).icon;
  if (own) return own;
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

/**
 * The pane's title with any icon the application prefixed to it removed, so
 * the icon is drawn once — in the icon's place — rather than twice.
 */
export function getTabLabel(pane: TmuxPane, titleOverride?: string): string {
  return splitTitleIcon(getTabText(pane, titleOverride)).text;
}
