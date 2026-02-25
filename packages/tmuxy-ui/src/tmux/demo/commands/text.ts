import type { CommandFn } from './types';
import { ok, err } from './types';

export const echo: CommandFn = (args, ctx) => {
  // Expand $VAR references
  const expanded = args.map((a) => a.replace(/\$(\w+)/g, (_, name) => ctx.env.get(name) ?? ''));
  return ok(expanded.join(' '));
};

export const head: CommandFn = (args, ctx) => {
  let n = 10;
  const paths: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-n' && i + 1 < args.length) {
      n = parseInt(args[++i], 10);
    } else {
      paths.push(args[i]);
    }
  }
  if (paths.length === 0) return err('head: missing file operand');
  const path = ctx.vfs.resolvePath(ctx.cwd, paths[0]);
  const content = ctx.vfs.readFile(path);
  if (content === null) return err(`head: cannot open '${paths[0]}': No such file or directory`);
  const lines = content.split('\n');
  return ok(lines.slice(0, n).join('\n'));
};

export const tail: CommandFn = (args, ctx) => {
  let n = 10;
  const paths: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-n' && i + 1 < args.length) {
      n = parseInt(args[++i], 10);
    } else {
      paths.push(args[i]);
    }
  }
  if (paths.length === 0) return err('tail: missing file operand');
  const path = ctx.vfs.resolvePath(ctx.cwd, paths[0]);
  const content = ctx.vfs.readFile(path);
  if (content === null) return err(`tail: cannot open '${paths[0]}': No such file or directory`);
  const lines = content.split('\n');
  // Remove trailing empty line from final newline
  if (lines[lines.length - 1] === '') lines.pop();
  return ok(lines.slice(-n).join('\n'));
};

export const wc: CommandFn = (args, ctx) => {
  if (args.length === 0) return err('wc: missing file operand');
  const results: string[] = [];
  for (const arg of args) {
    const path = ctx.vfs.resolvePath(ctx.cwd, arg);
    const content = ctx.vfs.readFile(path);
    if (content === null) {
      results.push(`wc: ${arg}: No such file or directory`);
      continue;
    }
    const lines = content.split('\n').length - (content.endsWith('\n') ? 1 : 0);
    const words = content.split(/\s+/).filter(Boolean).length;
    const bytes = content.length;
    results.push(`  ${lines}  ${words} ${bytes} ${arg}`);
  }
  return ok(results.join('\n'));
};

export const grep: CommandFn = (args, ctx) => {
  if (args.length < 2) return err('grep: missing arguments');
  const pattern = args[0];
  const paths = args.slice(1);
  const matches: string[] = [];
  const multiFile = paths.length > 1;

  for (const p of paths) {
    const path = ctx.vfs.resolvePath(ctx.cwd, p);
    const content = ctx.vfs.readFile(path);
    if (content === null) {
      matches.push(`grep: ${p}: No such file or directory`);
      continue;
    }
    for (const line of content.split('\n')) {
      if (line.includes(pattern)) {
        const highlighted = line.replace(
          new RegExp(escapeRegex(pattern), 'g'),
          `\x1b[1;31m${pattern}\x1b[0m`,
        );
        matches.push(multiFile ? `${p}:${highlighted}` : highlighted);
      }
    }
  }
  if (matches.length === 0) return { output: '', exitCode: 1 };
  return ok(matches.join('\n'));
};

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
