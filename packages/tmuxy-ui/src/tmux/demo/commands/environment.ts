import type { CommandFn } from './types';
import { ok, err } from './types';

export const env: CommandFn = (_args, ctx) => {
  const lines: string[] = [];
  for (const [key, value] of ctx.env) {
    lines.push(`${key}=${value}`);
  }
  return ok(lines.sort().join('\n'));
};

export const exportCmd: CommandFn = (args, ctx) => {
  for (const arg of args) {
    const eq = arg.indexOf('=');
    if (eq === -1) continue;
    const key = arg.slice(0, eq);
    const value = arg.slice(eq + 1);
    ctx.env.set(key, value);
  }
  return ok();
};

export const unset: CommandFn = (args, ctx) => {
  for (const arg of args) {
    ctx.env.delete(arg);
  }
  return ok();
};

export const whoami: CommandFn = () => ok('demo');

export const hostname: CommandFn = () => ok('tmuxy-demo');

export const uname: CommandFn = (args) => {
  if (args.includes('-a')) {
    return ok('Linux tmuxy-demo 6.1.0-demo #1 SMP x86_64 GNU/Linux');
  }
  return ok('Linux');
};

export const date: CommandFn = () => {
  return ok(new Date().toString());
};

export const printenv: CommandFn = (args, ctx) => {
  if (args.length === 0) return env(args, ctx);
  const val = ctx.env.get(args[0]);
  if (val === undefined) return err('', 1);
  return ok(val);
};
