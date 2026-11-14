import { describe, expect, it } from 'vitest';
import { DEFAULT_ROW_TEMPLATE, parseRowTemplate } from '../rowTemplate';

const kinds = (option: string) =>
  parseRowTemplate(option)?.map((line) =>
    line.map((it) => (it.kind === 'field' ? `field:${it.key}` : it.kind)).join(' '),
  ) ?? null;

describe('the tree row template', () => {
  it('reads lines and items as written', () => {
    expect(kinds('process ports id / cwd branch / title / fields')).toEqual([
      'process ports id',
      'cwd branch',
      'title',
      'fields',
    ]);
    expect(kinds('  title/process   id  ')).toEqual(['title', 'process id']);
    expect(kinds('process field:ci / field:task')).toEqual(['process field:ci', 'field:task']);
  });

  it('is the default as written out', () => {
    expect(kinds('process ports id / cwd branch / title / fields')).toEqual(
      DEFAULT_ROW_TEMPLATE.map((line) => line.map((it) => it.kind).join(' ')),
    );
  });

  it('is not used at all when any of it is not understood', () => {
    for (const bad of [
      '',
      '   ',
      'process / colour',
      'process //title',
      'process / ',
      'process process',
      'field:CI',
      'field:',
      'a / b / c / d / e / f / g'.replace(/[a-g]/g, 'title'),
      'process / cwd / branch / title / fields / id / ports',
    ]) {
      expect(kinds(bad)).toBeNull();
    }
  });
});
