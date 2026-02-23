import { describe, it, expect, beforeEach } from 'vitest';
import { FakeShell } from '../fakeShell';
import { VirtualFS } from '../virtualFs';

describe('FakeShell', () => {
  let vfs: VirtualFS;
  let shell: FakeShell;

  beforeEach(() => {
    vfs = new VirtualFS();
    shell = new FakeShell(vfs, 80, 24);
    shell.writePrompt();
  });

  function type(text: string): void {
    for (const ch of text) {
      shell.processKey(ch);
    }
  }

  function enter(): void {
    shell.processKey('Enter');
  }

  function getVisibleText(): string {
    return shell
      .getContent()
      .map((line) =>
        line
          .map((c) => c.c)
          .join('')
          .trimEnd(),
      )
      .filter((l) => l.length > 0)
      .join('\n');
  }

  describe('command execution', () => {
    it('runs pwd', () => {
      type('pwd');
      enter();
      const text = getVisibleText();
      expect(text).toContain('/home/demo');
    });

    it('runs echo', () => {
      type('echo hello world');
      enter();
      const text = getVisibleText();
      expect(text).toContain('hello world');
    });

    it('runs ls', () => {
      type('ls');
      enter();
      const text = getVisibleText();
      expect(text).toContain('projects');
      expect(text).toContain('documents');
    });

    it('runs cat on a file', () => {
      type('cat documents/notes.txt');
      enter();
      const text = getVisibleText();
      expect(text).toContain('Meeting notes');
    });

    it('handles command not found', () => {
      type('nonexistent');
      enter();
      const text = getVisibleText();
      expect(text).toContain('command not found');
    });

    it('handles known but unavailable commands', () => {
      type('git status');
      enter();
      const text = getVisibleText();
      expect(text).toContain('not available in this demo');
    });
  });

  describe('input handling', () => {
    it('handles backspace', () => {
      type('helo');
      shell.processKey('BSpace');
      shell.processKey('BSpace');
      type('lp');
      enter();
      const text = getVisibleText();
      expect(text).toContain('help');
    });

    it('handles Ctrl+C', () => {
      type('some input');
      shell.processKey('C-c');
      // Should show ^C and new prompt
      const text = getVisibleText();
      expect(text).toContain('^C');
    });

    it('handles literal text', () => {
      shell.processLiteral('echo test');
      enter();
      const text = getVisibleText();
      expect(text).toContain('test');
    });
  });

  describe('history', () => {
    it('navigates history with Up/Down', () => {
      type('echo first');
      enter();
      type('echo second');
      enter();

      shell.processKey('Up');
      expect(shell.inputBuffer).toBe('echo second');

      shell.processKey('Up');
      expect(shell.inputBuffer).toBe('echo first');

      shell.processKey('Down');
      expect(shell.inputBuffer).toBe('echo second');

      shell.processKey('Down');
      expect(shell.inputBuffer).toBe('');
    });
  });

  describe('pipes', () => {
    it('supports simple pipe', () => {
      type('echo hello | wc');
      enter();
      const text = getVisibleText();
      // wc should show line/word/byte count
      expect(text).toContain('1');
    });
  });

  describe('cd', () => {
    it('changes directory', () => {
      type('cd projects');
      enter();
      type('pwd');
      enter();
      const text = getVisibleText();
      expect(text).toContain('/home/demo/projects');
    });

    it('cd ~ goes home', () => {
      type('cd /tmp');
      enter();
      type('cd ~');
      enter();
      type('pwd');
      enter();
      const text = getVisibleText();
      expect(text).toContain('/home/demo');
    });

    it('cd with no args goes home', () => {
      type('cd /tmp');
      enter();
      type('cd');
      enter();
      expect(shell.cwd).toBe('/home/demo');
    });
  });

  describe('resize', () => {
    it('resizes grid', () => {
      shell.resize(40, 12);
      const content = shell.getContent();
      expect(content.length).toBe(12);
      expect(content[0].length).toBe(40);
    });
  });
});
