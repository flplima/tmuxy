import type { CommandFn } from './types';
import { ok } from './types';

export const help: CommandFn = () => {
  return ok(
    [
      'tmuxy demo shell - available commands:',
      '',
      '  Navigation:    cd, pwd, which',
      '  Filesystem:    ls, cat, mkdir, touch, rm, cp, mv',
      '  Text:          echo, head, tail, wc, grep',
      '  Environment:   env, export, unset, whoami, hostname, uname, date',
      '  Shell:         help, history, clear, exit, true, false',
      '',
      'This is a demo shell. Type "help" for this message.',
    ].join('\n'),
  );
};

export const history: CommandFn = (_args, ctx) => {
  if (ctx.history.length === 0) return ok('');
  const lines = ctx.history.map((cmd, i) => `  ${i + 1}  ${cmd}`);
  return ok(lines.join('\n'));
};

export const clear: CommandFn = () => {
  // Return ANSI clear screen sequence - DemoShell handles this specially
  return ok('\x1b[2J\x1b[H');
};

export const exit: CommandFn = () => {
  return ok('This is a demo shell. Close the pane with Ctrl+A, x instead.');
};

export const trueCmd: CommandFn = () => ok();

export const falseCmd: CommandFn = () => ({ output: '', exitCode: 1 });
