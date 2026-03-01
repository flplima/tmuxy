import type { ShellContext, CommandResult } from './types';
import { ok, err } from './types';

const USAGE = `Usage: tmuxy <command> [subcommand] [options]

Commands:
  pane list [--json] [--all]   List panes
  tab  list [--json]           List tabs (windows)

Options:
  --help                       Show this help message`;

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

function handlePane(subcommand: string, args: string[], ctx: ShellContext): CommandResult {
  if (!subcommand || subcommand === '--help') {
    return ok('Usage: tmuxy pane <list> [options]');
  }

  if (subcommand !== 'list') {
    return err(`tmuxy pane: unknown subcommand '${subcommand}'`);
  }

  if (!ctx.tmux) {
    return err('tmuxy: not connected to tmux');
  }

  const state = ctx.tmux.getState();
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

  // Table format
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

function handleTab(subcommand: string, args: string[], ctx: ShellContext): CommandResult {
  if (!subcommand || subcommand === '--help') {
    return ok('Usage: tmuxy tab <list> [options]');
  }

  if (subcommand !== 'list') {
    return err(`tmuxy tab: unknown subcommand '${subcommand}'`);
  }

  if (!ctx.tmux) {
    return err('tmuxy: not connected to tmux');
  }

  const state = ctx.tmux.getState();
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

  // Table format
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
