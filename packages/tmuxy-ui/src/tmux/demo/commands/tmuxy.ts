import type { ShellContext, CommandResult } from './types';
import { ok, err } from './types';

const USAGE = `Usage: tmuxy <command> [subcommand] [options]

Commands:
  pane        Manage panes (split, kill, select, resize, swap, zoom, break, send, float, group)
  tab         Manage tabs (create, kill, select, rename, layout)

Options:
  --help      Show this help message`;

const PANE_USAGE = `Usage: tmuxy pane <command> [args...]

Commands:
  list          List all panes [--json] [--all]
  split         Split current pane [-h|-v]
  kill          Kill a pane [%id]
  select        Select/focus a pane [-U|-D|-L|-R|%id]
  resize        Resize a pane [-U|-D|-L|-R] [n]
  swap          Swap two panes <src> <dst>
  zoom          Toggle pane zoom
  break         Break pane into own tab
  send          Send keys to pane <keys...>
  paste         Paste text into pane <text>
  float         Create a float pane [cmd args...]
  group         Pane group operations (add, close, switch, next, prev)`;

const TAB_USAGE = `Usage: tmuxy tab <command> [args...]

Commands:
  list          List all tabs [--json]
  create        Create a new tab [name]
  kill          Kill a tab [@id]
  select        Switch to a tab <index|@id>
  next          Next tab
  prev          Previous tab
  rename        Rename current tab <name>
  layout        Change pane layout [next]`;

const GROUP_USAGE = `Usage: tmuxy pane group <command> [args...]

Commands:
  add           Add current pane to a group
  close         Close pane from group [%id]
  switch        Switch to pane in group <%id>
  next          Next pane in group
  prev          Previous pane in group`;

function requireTmux(ctx: ShellContext) {
  if (!ctx.tmux) return err('tmuxy: not connected to tmux');
  return null;
}

export function tmuxy(args: string[], ctx: ShellContext): CommandResult {
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    return ok(USAGE);
  }

  const command = args[0];
  const subcommand = args[1];

  switch (command) {
    case 'pane':
      return handlePane(subcommand, args.slice(2), ctx);
    case 'tab':
      return handleTab(subcommand, args.slice(2), ctx);
    default:
      return err(`tmuxy: unknown command '${command}'\n${USAGE}`);
  }
}

// ============================================
// Pane commands
// ============================================

function handlePane(subcommand: string, args: string[], ctx: ShellContext): CommandResult {
  if (!subcommand || subcommand === '--help' || subcommand === '-h') {
    return ok(PANE_USAGE);
  }

  switch (subcommand) {
    case 'list':
      return paneList(args, ctx);
    case 'split':
      return paneSplit(args, ctx);
    case 'kill':
      return paneKill(args, ctx);
    case 'select':
      return paneSelect(args, ctx);
    case 'resize':
      return paneResize(args, ctx);
    case 'swap':
      return paneSwap(args, ctx);
    case 'zoom':
      return paneZoom(ctx);
    case 'break':
      return paneBreak(ctx);
    case 'capture':
      return paneCapture(args, ctx);
    case 'send':
      return paneSend(args, ctx);
    case 'paste':
      return panePaste(args, ctx);
    case 'float':
      return paneFloat(ctx);
    case 'group':
      return handlePaneGroup(args[0], args.slice(1), ctx);
    default:
      return err(`tmuxy pane: unknown subcommand '${subcommand}'\n${PANE_USAGE}`);
  }
}

function paneList(args: string[], ctx: ShellContext): CommandResult {
  const tmuxErr = requireTmux(ctx);
  if (tmuxErr) return tmuxErr;

  const state = ctx.tmux!.getState();
  const json = args.includes('--json');
  const all = args.includes('--all');

  const panes = all
    ? state.panes
    : state.panes.filter((p) => p.window_id === state.active_window_id);

  if (json) {
    const data = panes.map((p) => ({
      id: p.tmux_id,
      window_id: p.window_id,
      width: p.width,
      height: p.height,
      x: p.x,
      y: p.y,
      active: p.active,
      command: p.command,
      title: p.title,
    }));
    return ok(JSON.stringify(data, null, 2));
  }

  const header = 'ID        WINDOW    SIZE       COMMAND   ACTIVE';
  const lines = panes.map((p) => {
    const id = p.tmux_id.padEnd(10);
    const win = p.window_id.padEnd(10);
    const size = `${p.width}x${p.height}`.padEnd(11);
    const cmd = p.command.padEnd(10);
    const active = p.active ? '*' : '';
    return `${id}${win}${size}${cmd}${active}`;
  });
  return ok([header, ...lines].join('\n'));
}

function paneSplit(args: string[], ctx: ShellContext): CommandResult {
  if (args.includes('--help')) {
    return ok('Usage: tmuxy pane split [-h|-v]');
  }
  const tmuxErr = requireTmux(ctx);
  if (tmuxErr) return tmuxErr;

  // -h = vertical split (tmux convention: -h splits horizontally, creating vertical panes)
  const direction = args.includes('-h') ? 'vertical' : 'horizontal';
  const paneId = ctx.tmux!.splitPane(direction);
  if (!paneId) return err('tmuxy pane split: failed to split pane');
  return ok(paneId);
}

function paneKill(args: string[], ctx: ShellContext): CommandResult {
  if (args.includes('--help')) {
    return ok('Usage: tmuxy pane kill [%id]');
  }
  const tmuxErr = requireTmux(ctx);
  if (tmuxErr) return tmuxErr;

  const target = args.find((a) => a.startsWith('%'));
  const success = ctx.tmux!.killPane(target ?? undefined);
  if (!success) return err('tmuxy pane kill: failed to kill pane');
  return ok();
}

function paneSelect(args: string[], ctx: ShellContext): CommandResult {
  if (args.includes('--help')) {
    return ok('Usage: tmuxy pane select [-U|-D|-L|-R|%id]');
  }
  if (args.length === 0) {
    return err('Error: pane direction or ID required');
  }
  const tmuxErr = requireTmux(ctx);
  if (tmuxErr) return tmuxErr;

  const arg = args[0];
  const directionMap: Record<string, string> = {
    '-U': 'Up',
    '-D': 'Down',
    '-L': 'Left',
    '-R': 'Right',
  };

  if (directionMap[arg]) {
    const success = ctx.tmux!.selectPaneByDirection(directionMap[arg]);
    if (!success) return err('tmuxy pane select: no pane in that direction');
    return ok();
  }

  if (arg.startsWith('%')) {
    const success = ctx.tmux!.selectPane(arg);
    if (!success) return err(`tmuxy pane select: pane '${arg}' not found`);
    return ok();
  }

  return err(`Error: invalid argument '${arg}'. Use -U, -D, -L, -R, or %id`);
}

function paneResize(args: string[], ctx: ShellContext): CommandResult {
  if (args.includes('--help')) {
    return ok('Usage: tmuxy pane resize [-U|-D|-L|-R] [n]');
  }
  if (args.length === 0) {
    return err('Error: direction required (-U, -D, -L, -R)');
  }
  const tmuxErr = requireTmux(ctx);
  if (tmuxErr) return tmuxErr;

  const directionMap: Record<string, string> = {
    '-U': 'Up',
    '-D': 'Down',
    '-L': 'Left',
    '-R': 'Right',
  };

  const dirArg = args.find((a) => directionMap[a]);
  if (!dirArg) {
    return err('Error: direction required (-U, -D, -L, -R)');
  }

  const numArg = args.find((a) => /^\d+$/.test(a));
  const adjustment = numArg ? parseInt(numArg) : 1;

  const state = ctx.tmux!.getState();
  if (!state.active_pane_id) return err('tmuxy pane resize: no active pane');
  const success = ctx.tmux!.resizePane(state.active_pane_id, directionMap[dirArg], adjustment);
  if (!success) return err('tmuxy pane resize: failed to resize pane');
  return ok();
}

function paneSend(args: string[], ctx: ShellContext): CommandResult {
  if (args.includes('--help')) {
    return ok('Usage: tmuxy pane send <keys...>');
  }
  if (args.length === 0) {
    return err('Error: keys required');
  }
  const tmuxErr = requireTmux(ctx);
  if (tmuxErr) return tmuxErr;

  for (const key of args) {
    ctx.tmux!.sendKey(key);
  }
  return ok();
}

function panePaste(args: string[], ctx: ShellContext): CommandResult {
  if (args.includes('--help')) {
    return ok('Usage: tmuxy pane paste <text>');
  }
  if (args.length === 0) {
    return err('Error: text required');
  }
  const tmuxErr = requireTmux(ctx);
  if (tmuxErr) return tmuxErr;

  const text = args.join(' ');
  ctx.tmux!.sendLiteral(text);
  return ok();
}

function paneSwap(args: string[], ctx: ShellContext): CommandResult {
  if (args.includes('--help')) {
    return ok('Usage: tmuxy pane swap <src> <dst>');
  }
  if (args.length < 2) {
    return err('Usage: tmuxy pane swap <src> <dst>');
  }
  const tmuxErr = requireTmux(ctx);
  if (tmuxErr) return tmuxErr;

  const success = ctx.tmux!.swapPanes(args[0], args[1]);
  if (!success) return err('tmuxy pane swap: failed to swap panes');
  return ok();
}

function paneZoom(ctx: ShellContext): CommandResult {
  const tmuxErr = requireTmux(ctx);
  if (tmuxErr) return tmuxErr;

  const success = ctx.tmux!.toggleZoom();
  if (!success) return err('tmuxy pane zoom: cannot zoom (single pane)');
  return ok(ctx.tmux!.isZoomed() ? 'zoomed' : 'unzoomed');
}

function paneBreak(ctx: ShellContext): CommandResult {
  const tmuxErr = requireTmux(ctx);
  if (tmuxErr) return tmuxErr;

  const windowId = ctx.tmux!.breakPane();
  if (!windowId) return err('tmuxy pane break: cannot break (single pane)');
  return ok(windowId);
}

function paneCapture(args: string[], ctx: ShellContext): CommandResult {
  if (args.includes('--help')) {
    return ok('Usage: tmuxy pane capture [%id] [--json]');
  }
  const tmuxErr = requireTmux(ctx);
  if (tmuxErr) return tmuxErr;

  const target = args.find((a) => a.startsWith('%'));
  const content = ctx.tmux!.capturePane(target ?? undefined);
  const json = args.includes('--json');

  if (json) {
    return ok(JSON.stringify({ content }));
  }
  return ok(content);
}

function paneFloat(ctx: ShellContext): CommandResult {
  const tmuxErr = requireTmux(ctx);
  if (tmuxErr) return tmuxErr;

  const paneId = ctx.tmux!.createFloat();
  if (!paneId) return err('tmuxy pane float: failed to create float');
  return ok(paneId);
}

// ============================================
// Pane group commands
// ============================================

function handlePaneGroup(subcommand: string, args: string[], ctx: ShellContext): CommandResult {
  if (!subcommand || subcommand === '--help' || subcommand === '-h') {
    return ok(GROUP_USAGE);
  }

  switch (subcommand) {
    case 'add':
      return groupAdd(ctx);
    case 'close':
      return groupClose(args, ctx);
    case 'switch':
      return groupSwitchCmd(args, ctx);
    case 'next':
      return groupNext(ctx);
    case 'prev':
      return groupPrev(ctx);
    default:
      return err(`tmuxy pane group: unknown subcommand '${subcommand}'\n${GROUP_USAGE}`);
  }
}

function groupAdd(ctx: ShellContext): CommandResult {
  const tmuxErr = requireTmux(ctx);
  if (tmuxErr) return tmuxErr;

  const newPaneId = ctx.tmux!.groupAdd();
  if (!newPaneId) return err('tmuxy pane group add: failed to add pane to group');
  return ok(newPaneId);
}

function groupClose(args: string[], ctx: ShellContext): CommandResult {
  if (args.includes('--help')) {
    return ok('Usage: tmuxy pane group close [%id]');
  }
  const tmuxErr = requireTmux(ctx);
  if (tmuxErr) return tmuxErr;

  const target = args.find((a) => a.startsWith('%'));
  const success = ctx.tmux!.groupClose(target ?? undefined);
  if (!success) return err('tmuxy pane group close: pane not in a group');
  return ok();
}

function groupSwitchCmd(args: string[], ctx: ShellContext): CommandResult {
  if (args.includes('--help')) {
    return ok('Usage: tmuxy pane group switch <%id>');
  }
  if (args.length === 0) {
    return err('Error: pane ID required');
  }
  const tmuxErr = requireTmux(ctx);
  if (tmuxErr) return tmuxErr;

  const success = ctx.tmux!.groupSwitch(args[0]);
  if (!success) return err(`tmuxy pane group switch: failed to switch to '${args[0]}'`);
  return ok();
}

function groupNext(ctx: ShellContext): CommandResult {
  const tmuxErr = requireTmux(ctx);
  if (tmuxErr) return tmuxErr;

  const success = ctx.tmux!.groupNext();
  if (!success) return err('tmuxy pane group next: pane not in a group');
  return ok();
}

function groupPrev(ctx: ShellContext): CommandResult {
  const tmuxErr = requireTmux(ctx);
  if (tmuxErr) return tmuxErr;

  const success = ctx.tmux!.groupPrev();
  if (!success) return err('tmuxy pane group prev: pane not in a group');
  return ok();
}

// ============================================
// Tab commands
// ============================================

function handleTab(subcommand: string, args: string[], ctx: ShellContext): CommandResult {
  if (!subcommand || subcommand === '--help' || subcommand === '-h') {
    return ok(TAB_USAGE);
  }

  switch (subcommand) {
    case 'list':
      return tabList(args, ctx);
    case 'create':
      return tabCreate(args, ctx);
    case 'kill':
      return tabKill(args, ctx);
    case 'select':
      return tabSelect(args, ctx);
    case 'next':
      return tabNext(ctx);
    case 'prev':
      return tabPrev(ctx);
    case 'rename':
      return tabRename(args, ctx);
    case 'layout':
      return tabLayout(args, ctx);
    default:
      return err(`tmuxy tab: unknown subcommand '${subcommand}'\n${TAB_USAGE}`);
  }
}

function tabList(args: string[], ctx: ShellContext): CommandResult {
  const tmuxErr = requireTmux(ctx);
  if (tmuxErr) return tmuxErr;

  const state = ctx.tmux!.getState();
  const json = args.includes('--json');

  if (json) {
    const data = state.windows.map((w) => ({
      id: w.id,
      index: w.index,
      name: w.name,
      active: w.active,
    }));
    return ok(JSON.stringify(data, null, 2));
  }

  const header = 'ID        INDEX     NAME       ACTIVE';
  const lines = state.windows.map((w) => {
    const id = w.id.padEnd(10);
    const index = String(w.index).padEnd(10);
    const name = w.name.padEnd(11);
    const active = w.active ? '*' : '';
    return `${id}${index}${name}${active}`;
  });
  return ok([header, ...lines].join('\n'));
}

function tabCreate(args: string[], ctx: ShellContext): CommandResult {
  if (args.includes('--help')) {
    return ok('Usage: tmuxy tab create [name]');
  }
  const tmuxErr = requireTmux(ctx);
  if (tmuxErr) return tmuxErr;

  const windowId = ctx.tmux!.newWindow();
  const name = args[0];
  if (name) {
    ctx.tmux!.renameWindow(windowId, name);
  }
  return ok(windowId);
}

function tabKill(args: string[], ctx: ShellContext): CommandResult {
  if (args.includes('--help')) {
    return ok('Usage: tmuxy tab kill [@id]');
  }
  const tmuxErr = requireTmux(ctx);
  if (tmuxErr) return tmuxErr;

  const target = args.find((a) => a.startsWith('@'));
  const success = ctx.tmux!.killWindow(target ?? undefined);
  if (!success) return err('tmuxy tab kill: failed to kill tab');
  return ok();
}

function tabSelect(args: string[], ctx: ShellContext): CommandResult {
  if (args.includes('--help')) {
    return ok('Usage: tmuxy tab select <index|@id>');
  }
  if (args.length === 0) {
    return err('Error: tab index or @id required');
  }
  const tmuxErr = requireTmux(ctx);
  if (tmuxErr) return tmuxErr;

  const success = ctx.tmux!.selectWindow(args[0]);
  if (!success) return err(`tmuxy tab select: tab '${args[0]}' not found`);
  return ok();
}

function tabNext(ctx: ShellContext): CommandResult {
  const tmuxErr = requireTmux(ctx);
  if (tmuxErr) return tmuxErr;
  ctx.tmux!.nextWindow();
  return ok();
}

function tabPrev(ctx: ShellContext): CommandResult {
  const tmuxErr = requireTmux(ctx);
  if (tmuxErr) return tmuxErr;
  ctx.tmux!.previousWindow();
  return ok();
}

function tabRename(args: string[], ctx: ShellContext): CommandResult {
  if (args.includes('--help')) {
    return ok('Usage: tmuxy tab rename <name>');
  }
  if (args.length === 0) {
    return err('Error: name required');
  }
  const tmuxErr = requireTmux(ctx);
  if (tmuxErr) return tmuxErr;

  const state = ctx.tmux!.getState();
  if (!state.active_window_id) return err('tmuxy tab rename: no active tab');
  const success = ctx.tmux!.renameWindow(state.active_window_id, args[0]);
  if (!success) return err('tmuxy tab rename: failed to rename tab');
  return ok();
}

function tabLayout(args: string[], ctx: ShellContext): CommandResult {
  if (args.includes('--help')) {
    return ok('Usage: tmuxy tab layout [next]');
  }
  const tmuxErr = requireTmux(ctx);
  if (tmuxErr) return tmuxErr;

  ctx.tmux!.nextLayout();
  return ok();
}
