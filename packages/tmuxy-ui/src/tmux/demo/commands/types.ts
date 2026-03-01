import type { VirtualFS } from '../virtualFs';
import type { DemoTmux } from '../DemoTmux';

export interface ShellContext {
  cwd: string;
  env: Map<string, string>;
  vfs: VirtualFS;
  history: string[];
  tmux?: DemoTmux;
}

export type CommandFn = (args: string[], ctx: ShellContext) => CommandResult;

export interface CommandResult {
  output: string;
  exitCode: number;
}

export function ok(output = ''): CommandResult {
  return { output, exitCode: 0 };
}

export function err(output: string, code = 1): CommandResult {
  return { output, exitCode: code };
}
