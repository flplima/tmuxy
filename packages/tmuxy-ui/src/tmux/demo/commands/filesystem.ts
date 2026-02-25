import type { CommandFn } from './types';
import { ok, err } from './types';

export const ls: CommandFn = (args, ctx) => {
  let showAll = false;
  let showLong = false;
  const paths: string[] = [];

  for (const arg of args) {
    if (arg === '-a') showAll = true;
    else if (arg === '-l') showLong = true;
    else if (arg === '-la' || arg === '-al') {
      showAll = true;
      showLong = true;
    } else paths.push(arg);
  }

  const target = paths[0] ? ctx.vfs.resolvePath(ctx.cwd, paths[0]) : ctx.cwd;
  const node = ctx.vfs.stat(target);
  if (!node) return err(`ls: cannot access '${paths[0] || target}': No such file or directory`);

  if (node.type === 'file') {
    const name = target.split('/').pop()!;
    if (showLong) {
      return ok(
        `${node.permissions} 1 demo demo ${(node.content ?? '').length} ${fmtDate(node.modified)} ${name}`,
      );
    }
    return ok(name);
  }

  const entries = ctx.vfs.readdir(target) ?? [];
  const filtered = showAll ? ['.', '..', ...entries] : entries.filter((e) => !e.startsWith('.'));

  if (!showLong) {
    return ok(filtered.join('  '));
  }

  const lines = [`total ${filtered.length}`];
  for (const name of filtered) {
    if (name === '.' || name === '..') {
      lines.push(`drwxr-xr-x 2 demo demo 4096 ${fmtDate(Date.now())} ${name}`);
      continue;
    }
    const childPath = target === '/' ? `/${name}` : `${target}/${name}`;
    const child = ctx.vfs.stat(childPath);
    if (child) {
      const size = child.type === 'file' ? (child.content ?? '').length : 4096;
      lines.push(
        `${child.permissions} 1 demo demo ${String(size).padStart(5)} ${fmtDate(child.modified)} ${name}`,
      );
    }
  }
  return ok(lines.join('\n'));
};

function fmtDate(ts: number): string {
  const d = new Date(ts);
  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  return `${months[d.getMonth()]} ${String(d.getDate()).padStart(2)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export const cat: CommandFn = (args, ctx) => {
  if (args.length === 0) return err('cat: missing operand');
  const outputs: string[] = [];
  for (const arg of args) {
    const path = ctx.vfs.resolvePath(ctx.cwd, arg);
    const content = ctx.vfs.readFile(path);
    if (content === null) {
      const node = ctx.vfs.stat(path);
      if (node?.type === 'directory') return err(`cat: ${arg}: Is a directory`);
      return err(`cat: ${arg}: No such file or directory`);
    }
    outputs.push(content);
  }
  // Remove trailing newline for display (shell will add newline)
  const result = outputs.join('');
  return ok(result.endsWith('\n') ? result.slice(0, -1) : result);
};

export const mkdir: CommandFn = (args, ctx) => {
  let recursive = false;
  const paths: string[] = [];
  for (const arg of args) {
    if (arg === '-p') recursive = true;
    else paths.push(arg);
  }
  if (paths.length === 0) return err('mkdir: missing operand');
  for (const p of paths) {
    const path = ctx.vfs.resolvePath(ctx.cwd, p);
    if (!ctx.vfs.mkdir(path, recursive)) {
      if (ctx.vfs.exists(path)) return err(`mkdir: cannot create directory '${p}': File exists`);
      return err(`mkdir: cannot create directory '${p}': No such file or directory`);
    }
  }
  return ok();
};

export const touch: CommandFn = (args, ctx) => {
  if (args.length === 0) return err('touch: missing file operand');
  for (const arg of args) {
    const path = ctx.vfs.resolvePath(ctx.cwd, arg);
    if (!ctx.vfs.exists(path)) {
      ctx.vfs.writeFile(path, '');
    }
  }
  return ok();
};

export const rm: CommandFn = (args, ctx) => {
  let recursive = false;
  const paths: string[] = [];
  for (const arg of args) {
    if (arg === '-r' || arg === '-rf' || arg === '-fr') recursive = true;
    else if (arg === '-f') {
      /* ignore force flag */
    } else paths.push(arg);
  }
  if (paths.length === 0) return err('rm: missing operand');
  for (const p of paths) {
    const path = ctx.vfs.resolvePath(ctx.cwd, p);
    const node = ctx.vfs.stat(path);
    if (!node) return err(`rm: cannot remove '${p}': No such file or directory`);
    if (node.type === 'directory' && !recursive)
      return err(`rm: cannot remove '${p}': Is a directory`);
    ctx.vfs.rm(path, recursive);
  }
  return ok();
};

export const cp: CommandFn = (args, ctx) => {
  if (args.length < 2) return err('cp: missing file operand');
  const src = ctx.vfs.resolvePath(ctx.cwd, args[0]);
  const dest = ctx.vfs.resolvePath(ctx.cwd, args[1]);
  if (!ctx.vfs.cp(src, dest)) return err(`cp: cannot copy '${args[0]}': No such file or directory`);
  return ok();
};

export const mv: CommandFn = (args, ctx) => {
  if (args.length < 2) return err('mv: missing file operand');
  const src = ctx.vfs.resolvePath(ctx.cwd, args[0]);
  const dest = ctx.vfs.resolvePath(ctx.cwd, args[1]);
  if (!ctx.vfs.mv(src, dest)) return err(`mv: cannot move '${args[0]}': No such file or directory`);
  return ok();
};
