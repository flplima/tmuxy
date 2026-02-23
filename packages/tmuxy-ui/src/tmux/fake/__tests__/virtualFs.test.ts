import { describe, it, expect, beforeEach } from 'vitest';
import { VirtualFS } from '../virtualFs';

describe('VirtualFS', () => {
  let vfs: VirtualFS;

  beforeEach(() => {
    vfs = new VirtualFS();
  });

  describe('seed content', () => {
    it('has home directory', () => {
      expect(vfs.exists('/home/demo')).toBe(true);
      expect(vfs.stat('/home/demo')?.type).toBe('directory');
    });

    it('has sample files', () => {
      expect(vfs.exists('/home/demo/projects/myapp/package.json')).toBe(true);
      expect(vfs.readFile('/home/demo/projects/myapp/package.json')).toContain('"name": "myapp"');
    });

    it('has documents', () => {
      expect(vfs.readFile('/home/demo/documents/notes.txt')).toContain('Meeting notes');
    });
  });

  describe('resolvePath', () => {
    it('resolves absolute paths', () => {
      expect(vfs.resolvePath('/home/demo', '/tmp')).toBe('/tmp');
    });

    it('resolves relative paths', () => {
      expect(vfs.resolvePath('/home/demo', 'projects')).toBe('/home/demo/projects');
    });

    it('resolves tilde', () => {
      expect(vfs.resolvePath('/tmp', '~')).toBe('/home/demo');
      expect(vfs.resolvePath('/tmp', '~/projects')).toBe('/home/demo/projects');
    });

    it('resolves . and ..', () => {
      expect(vfs.resolvePath('/home/demo/projects', '..')).toBe('/home/demo');
      expect(vfs.resolvePath('/home/demo', './projects')).toBe('/home/demo/projects');
      expect(vfs.resolvePath('/home/demo/projects/myapp', '../../..')).toBe('/home');
    });

    it('resolves to root on excessive ..', () => {
      expect(vfs.resolvePath('/home', '../../../../..')).toBe('/');
    });
  });

  describe('readdir', () => {
    it('lists directory contents', () => {
      const entries = vfs.readdir('/home/demo');
      expect(entries).toContain('projects');
      expect(entries).toContain('documents');
    });

    it('returns null for non-directory', () => {
      expect(vfs.readdir('/home/demo/documents/notes.txt')).toBeNull();
    });

    it('returns null for non-existent', () => {
      expect(vfs.readdir('/nonexistent')).toBeNull();
    });

    it('lists only direct children', () => {
      const entries = vfs.readdir('/home/demo/projects');
      expect(entries).toEqual(['myapp']);
    });
  });

  describe('readFile', () => {
    it('reads file content', () => {
      const content = vfs.readFile('/etc/hostname');
      expect(content).toBe('tmuxy-demo\n');
    });

    it('returns null for directory', () => {
      expect(vfs.readFile('/home/demo')).toBeNull();
    });

    it('returns null for non-existent', () => {
      expect(vfs.readFile('/nope')).toBeNull();
    });
  });

  describe('writeFile', () => {
    it('creates new file', () => {
      vfs.writeFile('/tmp/test.txt', 'hello');
      expect(vfs.readFile('/tmp/test.txt')).toBe('hello');
    });

    it('overwrites existing file', () => {
      vfs.writeFile('/etc/hostname', 'new-host\n');
      expect(vfs.readFile('/etc/hostname')).toBe('new-host\n');
    });
  });

  describe('mkdir', () => {
    it('creates directory', () => {
      expect(vfs.mkdir('/tmp/newdir')).toBe(true);
      expect(vfs.stat('/tmp/newdir')?.type).toBe('directory');
    });

    it('fails if parent does not exist', () => {
      expect(vfs.mkdir('/nonexistent/dir')).toBe(false);
    });

    it('fails if already exists', () => {
      expect(vfs.mkdir('/tmp')).toBe(false);
    });

    it('creates recursively with -p', () => {
      expect(vfs.mkdir('/tmp/a/b/c', true)).toBe(true);
      expect(vfs.exists('/tmp/a')).toBe(true);
      expect(vfs.exists('/tmp/a/b')).toBe(true);
      expect(vfs.exists('/tmp/a/b/c')).toBe(true);
    });
  });

  describe('rm', () => {
    it('removes file', () => {
      vfs.writeFile('/tmp/del.txt', 'x');
      expect(vfs.rm('/tmp/del.txt')).toBe(true);
      expect(vfs.exists('/tmp/del.txt')).toBe(false);
    });

    it('fails on non-empty directory without recursive', () => {
      expect(vfs.rm('/home/demo')).toBe(false);
    });

    it('removes directory recursively', () => {
      expect(vfs.rm('/home/demo/projects', true)).toBe(true);
      expect(vfs.exists('/home/demo/projects')).toBe(false);
      expect(vfs.exists('/home/demo/projects/myapp')).toBe(false);
    });

    it('returns false for non-existent', () => {
      expect(vfs.rm('/nope')).toBe(false);
    });
  });

  describe('cp', () => {
    it('copies file', () => {
      expect(vfs.cp('/etc/hostname', '/tmp/hostname-copy')).toBe(true);
      expect(vfs.readFile('/tmp/hostname-copy')).toBe('tmuxy-demo\n');
    });

    it('fails for non-existent source', () => {
      expect(vfs.cp('/nope', '/tmp/x')).toBe(false);
    });
  });

  describe('mv', () => {
    it('moves file', () => {
      vfs.writeFile('/tmp/a.txt', 'content');
      expect(vfs.mv('/tmp/a.txt', '/tmp/b.txt')).toBe(true);
      expect(vfs.exists('/tmp/a.txt')).toBe(false);
      expect(vfs.readFile('/tmp/b.txt')).toBe('content');
    });

    it('moves directory with children', () => {
      vfs.mkdir('/tmp/srcdir');
      vfs.writeFile('/tmp/srcdir/file.txt', 'data');
      expect(vfs.mv('/tmp/srcdir', '/tmp/destdir')).toBe(true);
      expect(vfs.exists('/tmp/srcdir')).toBe(false);
      expect(vfs.readFile('/tmp/destdir/file.txt')).toBe('data');
    });
  });
});
