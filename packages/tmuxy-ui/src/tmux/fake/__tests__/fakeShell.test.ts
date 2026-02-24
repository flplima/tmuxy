import { describe, it, expect, beforeEach } from 'vitest';
import { Sandbox } from '@lifo-sh/core';
import { FakeShell } from '../fakeShell';

describe('FakeShell', () => {
  let sandbox: Sandbox;
  let shell: FakeShell;

  beforeEach(async () => {
    sandbox = await Sandbox.create({
      persist: false,
      files: {
        '/home/user/projects/myapp/package.json': '{"name":"myapp"}',
        '/home/user/documents/notes.txt': 'Meeting notes\n- Item 1\n- Item 2\n',
      },
    });
    shell = new FakeShell(sandbox, 80, 24);
    shell.writePrompt();
  });

  function type(text: string): void {
    for (const ch of text) {
      shell.processKey(ch);
    }
  }

  async function enter(): Promise<void> {
    shell.processKey('Enter');
    await shell.waitForCompletion();
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

  describe('command execution via lifo', () => {
    it('runs pwd', async () => {
      type('pwd');
      await enter();
      const text = getVisibleText();
      expect(text).toContain('/home/user');
    });

    it('runs echo', async () => {
      type('echo hello world');
      await enter();
      const text = getVisibleText();
      expect(text).toContain('hello world');
    });

    it('runs ls', async () => {
      type('ls');
      await enter();
      const text = getVisibleText();
      expect(text).toContain('projects');
      expect(text).toContain('documents');
    });

    it('runs cat on a file', async () => {
      type('cat documents/notes.txt');
      await enter();
      const text = getVisibleText();
      expect(text).toContain('Meeting notes');
    });

    it('handles command not found', async () => {
      type('nonexistent_command');
      await enter();
      const text = getVisibleText();
      expect(text).toContain('not found');
    });

    it('supports pipes', async () => {
      type('echo hello | wc -l');
      await enter();
      const text = getVisibleText();
      expect(text).toContain('1');
    });

    it('supports && operator', async () => {
      type('echo first && echo second');
      await enter();
      const text = getVisibleText();
      expect(text).toContain('first');
      expect(text).toContain('second');
    });

    it('runs grep', async () => {
      type('grep Item documents/notes.txt');
      await enter();
      const text = getVisibleText();
      expect(text).toContain('Item 1');
      expect(text).toContain('Item 2');
    });
  });

  describe('input handling', () => {
    it('handles backspace', async () => {
      type('helo');
      shell.processKey('BSpace');
      shell.processKey('BSpace');
      type('lp');
      await enter();
      const text = getVisibleText();
      expect(text).toContain('help');
    });

    it('handles Ctrl+C', () => {
      type('some input');
      shell.processKey('C-c');
      const text = getVisibleText();
      expect(text).toContain('^C');
    });

    it('handles literal text', async () => {
      shell.processLiteral('echo test');
      await enter();
      const text = getVisibleText();
      expect(text).toContain('test');
    });
  });

  describe('history', () => {
    it('navigates history with Up/Down', async () => {
      type('echo first');
      await enter();
      type('echo second');
      await enter();

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

  describe('cd', () => {
    it('changes directory', async () => {
      type('cd projects');
      await enter();
      type('pwd');
      await enter();
      const text = getVisibleText();
      expect(text).toContain('/home/user/projects');
    });

    it('cd ~ goes home', async () => {
      type('cd /tmp');
      await enter();
      type('cd ~');
      await enter();
      type('pwd');
      await enter();
      const text = getVisibleText();
      expect(text).toContain('/home/user');
    });

    it('cd with no args goes home', async () => {
      type('cd /tmp');
      await enter();
      type('cd');
      await enter();
      expect(shell.cwd).toBe('/home/user');
    });
  });

  describe('clear', () => {
    it('clears the screen', () => {
      type('clear');
      shell.processKey('Enter');
      // clear is intercepted synchronously — no need to await
      const content = shell.getContent();
      // After clear, first non-empty line should be the prompt
      const firstLine = content[0]
        .map((c) => c.c)
        .join('')
        .trimEnd();
      expect(firstLine).toContain('demo@tmuxy');
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
