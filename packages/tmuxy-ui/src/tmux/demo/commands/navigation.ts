import type { CommandFn, CommandResult } from './types';
import { ok, err } from './types';

export const cd: CommandFn = (args, ctx): CommandResult => {
  const target = args[0] ?? '~';
  if (target === '-') {
    const prev = ctx.env.get('OLDPWD');
    if (!prev) return err('cd: OLDPWD not set');
    const node = ctx.vfs.stat(prev);
    if (!node || node.type !== 'directory') return err(`cd: ${prev}: No such file or directory`);
    ctx.env.set('OLDPWD', ctx.cwd);
    // cwd update is handled by the shell after command returns
    return { output: '', exitCode: 0 };
  }

  const path = ctx.vfs.resolvePath(ctx.cwd, target);
  const node = ctx.vfs.stat(path);
  if (!node) return err(`cd: ${target}: No such file or directory`);
  if (node.type !== 'directory') return err(`cd: ${target}: Not a directory`);
  ctx.env.set('OLDPWD', ctx.cwd);
  // Return the resolved path in output so DemoShell can update cwd
  return { output: path, exitCode: 0 };
};

export const pwd: CommandFn = (_args, ctx) => {
  return ok(ctx.cwd);
};

export const which: CommandFn = (args, _ctx) => {
  const builtins = new Set([
    'ls',
    'cat',
    'mkdir',
    'touch',
    'rm',
    'cp',
    'mv',
    'head',
    'tail',
    'wc',
    'grep',
    'echo',
    'cd',
    'pwd',
    'which',
    'env',
    'export',
    'unset',
    'whoami',
    'hostname',
    'uname',
    'date',
    'help',
    'history',
    'clear',
    'exit',
    'true',
    'false',
  ]);
  if (args.length === 0) return err('which: missing argument');
  const results: string[] = [];
  let code = 0;
  for (const cmd of args) {
    if (builtins.has(cmd)) {
      results.push(`/usr/bin/${cmd}`);
    } else {
      results.push(`${cmd} not found`);
      code = 1;
    }
  }
  return { output: results.join('\n'), exitCode: code };
};
