import { describe, expect, it } from 'vitest';
import { blankStringsAndComments, longRustFunctions } from './complexity.mjs';

const body = (n) => Array.from({ length: n }, (_, i) => `    let x${i} = ${i};`).join('\n');

describe('complexity', () => {
  it('finds a Rust function whose body runs past the limit, and only that one', () => {
    const text = `fn short() {\n${body(3)}\n}\n\npub fn long(a: u8) -> u8 {\n${body(12)}\n}\n`;
    expect(longRustFunctions(text, 10)).toEqual(['long:7']);
  });

  it('is not fooled by braces in strings or comments, or by a declaration', () => {
    const text = [
      'trait T { fn declared(&self); }',
      'fn quoted() {',
      '    let a = "{{{ not a brace";',
      '    let b = r#"} also not "#;',
      '    // } nor this',
      '    /* { or this */',
      body(2),
      '}',
      'fn after() {',
      body(12),
      '}',
    ].join('\n');
    expect(longRustFunctions(text, 10)).toEqual(['after:10']);
  });

  it('blanks strings and comments but keeps every line break', () => {
    const text = 'let a = "x\\"y"; // c\n/* d\ne */ let b = 1;';
    const blanked = blankStringsAndComments(text);
    expect(blanked.split('\n')).toHaveLength(3);
    // The string's text and both comments are gone.
    expect(blanked).not.toMatch(/x|y|\/\/|\/\*|\*\/|\bc\b|\bd\b|\be\b/);
    expect(blanked).toContain('let b = 1;');
  });
});
