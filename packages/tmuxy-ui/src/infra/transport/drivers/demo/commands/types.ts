import type { DemoTmux } from '../DemoTmux';

export interface ShellContext {
  cwd: string;
  env: Map<string, string>;
  history: string[];
  tmux?: DemoTmux;
}

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
