import { describe, expect, it } from 'vitest';
import { duplicatedLines, normal } from './duplication.mjs';

const block = (tag) =>
  Array.from({ length: 8 }, (_, i) => `const ${tag}${i} = compute(${i}, '${tag}');`).join('\n');

describe('duplication', () => {
  it('counts a run of lines copied into another file, re-indented or not', () => {
    const copy = block('a');
    const files = {
      'a.ts': `${copy}\nconst unique = 1;`,
      'b.ts': copy.replace(/^/gm, '    '),
    };
    expect(duplicatedLines(files, 8)).toBe(16);
  });

  it('counts nothing when runs differ, or are shorter than the window', () => {
    expect(duplicatedLines({ 'a.ts': block('a'), 'b.ts': block('b') }, 8)).toBe(0);
    const short = block('a').split('\n').slice(0, 7).join('\n');
    expect(duplicatedLines({ 'a.ts': short, 'b.ts': short }, 8)).toBe(0);
  });

  it('does not compare blanks, comments, imports or lone punctuation', () => {
    for (const line of [
      '',
      '   ',
      '// note',
      ' * doc',
      '#[derive(Debug)]',
      'import { a } from "b";',
      'use crate::x;',
      '});',
      '}',
    ]) {
      expect(normal(line), JSON.stringify(line)).toBeNull();
    }
    expect(normal('  let  x =  1;')).toBe('let x = 1;');
  });
});
