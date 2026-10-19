/**
 * A paste reaches the demo's shell intact.
 *
 * The client pastes through a tmux buffer (`set-buffer` with octal-escaped
 * text, then `paste-buffer -p`), so the demo engine — the demo site and every
 * Storybook story — must stage and replay that pair the way tmux does for a
 * pane without bracketed paste: the text, a Return for each newline.
 */

import { describe, it, expect } from 'vitest';
import { DemoTmux } from '../DemoTmux';
import { decodeDoubleQuoted, executeDemoCommand } from '../demoCommandExec';
import { TmuxOp, toTmuxCommand } from '../../../../../domain/commands';
import { pid } from '../../../../../test/wire';

/** The send-keys the demo engine runs for a paste of `text` into `%0`. */
function replay(text: string): { tmux: DemoTmux; sent: string[][] } {
  const tmux = new DemoTmux();
  const sent: string[][] = [];
  const record = (args: string[]) => sent.push(args);
  const command = toTmuxCommand(TmuxOp.PasteText({ target: pid('%0'), text }));
  for (const line of command.split('\n')) executeDemoCommand(tmux, line, () => {}, record);
  return { tmux, sent };
}

describe('demo paste', () => {
  it('replays a multi-line paste as its lines with a Return between them', () => {
    expect(replay('echo $HOME; ls #{x}\n~ "q" \\ é').sent).toEqual([
      ['-t', '%0', '-l', '--', 'echo $HOME; ls #{x}'],
      ['-t', '%0', 'Enter'],
      ['-t', '%0', '-l', '--', '~ "q" \\ é'],
    ]);
  });

  it('reassembles a paste staged in several chunks, and drops the buffer after', () => {
    const text = 'x'.repeat(1200);
    const { tmux, sent } = replay(text);
    expect(sent).toEqual([['-t', '%0', '-l', '--', text]]);
    expect(tmux.buffers.read('tmuxy-paste', false)).toBeUndefined();
  });

  it('decodes the octal byte escapes tmux reads, UTF-8 included', () => {
    expect(decodeDoubleQuoted('a\\012b \\303\\251 \\042\\134')).toBe('a\nb é "\\');
  });
});
