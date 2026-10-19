/**
 * The demo shell's command lines: split the way a shell splits them, since
 * the stories type real shell syntax (`printf '…' > file`) at it.
 */

import { describe, it, expect } from 'vitest';
import { parseLine, printf } from '../demoShellCommands';
import { DemoFiles, resolvePath } from '../demoFiles';

describe('parseLine', () => {
  it('splits words, keeps quoted spaces and takes the > target', () => {
    expect(parseLine(`printf 'a b\\n' > notes.md`)).toEqual({
      argv: ['printf', 'a b\\n'],
      redirect: 'notes.md',
    });
    expect(parseLine('echo "x \\"y\\"" z>out')).toEqual({
      argv: ['echo', 'x "y"', 'z'],
      redirect: 'out',
    });
    expect(parseLine(`echo '' a\\ b`)).toEqual({ argv: ['echo', '', 'a b'], redirect: null });
  });
});

describe('printf', () => {
  it('fills %s, and spells %% and the backslash escapes', () => {
    expect(printf('%s=%s 100%%\\n\\tend\\\\', ['a', 'b'])).toBe('a=b 100%\n\tend\\');
  });
});

describe('DemoFiles', () => {
  it('writes only into folders that exist, as a disk does', () => {
    const files = new DemoFiles();
    const at = (p: string) => resolvePath('/home/demo', p);
    expect(files.write(at('site/index.html'), 'x')).toBe(false);
    files.mkdir(at('site/css'));
    expect(files.write(at('site/css/../index.html'), 'page')).toBe(true);
    expect(new TextDecoder().decode(files.read('/home/demo/site/index.html')!)).toBe('page');
    expect(files.read(at('missing.md'))).toBeNull();
  });
});
