import type { TmuxPane } from '../domain/client';
import { paneWidgetOf } from './widgets/registry';
import { circledNumber } from '../domain/paneState';
import { AGY_SVG, CLAUDE_SVG, CODEX_SVG } from './processIconSvgs';

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
  claude: '\u273b', // ✻ the mark Claude Code puts in front of its own title
};

const DEFAULT_ICON = '\ue795'; //  nf-custom-terminal

const svgIcon = (svg: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

/** `@tmuxy-icon-<process>` replaces these. */
const BUILTIN_SVG_ICONS: Readonly<Record<string, string>> = {
  claude: svgIcon(CLAUDE_SVG),
  codex: svgIcon(CODEX_SVG),
  agy: svgIcon(AGY_SVG),
  antigravity: svgIcon(AGY_SVG),
};

export function isSvgIcon(icon: string): boolean {
  return icon.startsWith('data:image/svg+xml');
}

/**
 * Below it are ASCII, Latin and the punctuation blocks (quotation marks,
 * dashes); above it the arrows, shapes, dingbats, emoji and private-use icon
 * fonts an application might lead its title with.
 */
const FIRST_SYMBOL_CODEPOINT = 0x2070;

function getProcessIcon(command: string): string {
  const name = command.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(PROCESS_ICONS, name)) return PROCESS_ICONS[name];
  if (name.includes('docker')) return PROCESS_ICONS.docker;
  return DEFAULT_ICON;
}

/**
 * The icon an application put at the front of its own title (Claude Code
 * announces `\u273b claude`), which wins over the process table. Only a
 * symbol followed by a space counts, so the first character of a word or a
 * leading quotation mark or dash stays title.
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

/** A tab named with an emoji first (`🚀 deploy`) wears that emoji as its icon. */
export function splitLeadingEmoji(name: string): { emoji: string | null; rest: string } {
  const points = [...name];
  if (!points[0] || !/\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(points[0])) {
    return { emoji: null, rest: name };
  }
  // One emoji may be several code points: a flag is two regional indicators,
  // and a variation selector, a skin tone or a ZWJ joining the next pictograph
  // all belong to the glyph before them.
  let end = 1;
  if (
    /\p{Regional_Indicator}/u.test(points[0]) &&
    /\p{Regional_Indicator}/u.test(points[1] ?? '')
  ) {
    end = 2;
  }
  while (end < points.length) {
    const p = points[end];
    if (p === '\ufe0f' || /\p{Emoji_Modifier}/u.test(p)) end += 1;
    else if (p === '\u200d' && end + 1 < points.length) end += 2;
    else break;
  }
  const emoji = points.slice(0, end).join('');
  return { emoji, rest: name.slice(emoji.length).trimStart() };
}

/** The same on the tab strip and in the tree. */
export function tabIcon(name: string, position: number): { icon: string; label: string } {
  const { emoji, rest } = splitLeadingEmoji(name);
  return {
    icon: emoji ?? circledNumber(position),
    label: (emoji ? rest : name) || `Tab ${position}`,
  };
}

/** A glyph, or an SVG as a `data:` URL (`isSvgIcon`). `custom` is `@tmuxy-icon-<process>`. */
export function getTabIcon(
  pane: TmuxPane,
  titleOverride?: string,
  custom: Readonly<Record<string, string>> = {},
): string | null {
  const widgetIcon = paneWidgetOf(pane)?.definition.icon;
  if (widgetIcon) return widgetIcon;
  const command = pane.command.toLowerCase();
  const ownIcon = (map: Readonly<Record<string, string>>) =>
    Object.prototype.hasOwnProperty.call(map, command) ? map[command] : undefined;
  const configured = ownIcon(custom) ?? ownIcon(BUILTIN_SVG_ICONS);
  if (configured) return configured;
  const own = splitTitleIcon(getTabText(pane, titleOverride)).icon;
  if (own) return own;
  if (pane.command) return getProcessIcon(pane.command);
  return null;
}

/**
 * `pane.title` is what the program announced over OSC 0/2; the backend blanks
 * tmux's default host-name seed, so a non-empty title means an app set it.
 * `pane.command` is only the executable's file name (the backend rewrites a
 * version-pinned launcher's bare `2.1.280`).
 */
export function getTabText(pane: TmuxPane, titleOverride?: string): string {
  if (pane.inMode) return '[COPY MODE]';
  if (titleOverride) return titleOverride;
  return pane.title || pane.command || pane.borderTitle.trim() || 'shell';
}

/** The pinned terminal column's title; `null` while the pane is still being broken out. */
export function sidebarShellTitle(pane: TmuxPane | null): string {
  return pane ? getTabText(pane) : 'shell';
}

export function getTabLabel(pane: TmuxPane, titleOverride?: string): string {
  return splitTitleIcon(getTabText(pane, titleOverride)).text;
}

/**
 * The sidebar tree's two-line row: `process` (`#{pane_current_command}`, or
 * the widget's name) tells two panes apart in a narrow column, and `title`
 * (OSC 0/2) gets a line of its own because it routinely outgrows one. `title`
 * is empty when it adds nothing, so a plain shell stays a one-line row.
 */
export function paneRowLines(pane: TmuxPane): { process: string; title: string } {
  const process = paneWidgetOf(pane)?.name || pane.command || 'shell';
  if (pane.inMode) return { process, title: '[COPY MODE]' };
  const title = splitTitleIcon(pane.title || '').text.trim();
  return { process, title: title === process ? '' : title };
}
