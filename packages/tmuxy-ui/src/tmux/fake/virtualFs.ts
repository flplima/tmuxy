export interface VFSNode {
  type: 'file' | 'directory';
  content?: string;
  modified: number;
  permissions: string;
}

export class VirtualFS {
  private nodes = new Map<string, VFSNode>();

  constructor() {
    this.seed();
  }

  private seed(): void {
    const now = Date.now();
    const dirs = [
      '/',
      '/home',
      '/home/demo',
      '/home/demo/projects',
      '/home/demo/projects/myapp',
      '/home/demo/projects/myapp/src',
      '/home/demo/documents',
      '/home/demo/.config',
      '/tmp',
      '/usr',
      '/usr/bin',
      '/etc',
    ];
    for (const d of dirs) {
      this.nodes.set(d, { type: 'directory', modified: now, permissions: 'drwxr-xr-x' });
    }

    const files: [string, string][] = [
      [
        '/home/demo/.bashrc',
        '# ~/.bashrc\nexport PATH="$HOME/bin:$PATH"\nalias ll="ls -la"\nalias gs="git status"\n',
      ],
      [
        '/home/demo/projects/myapp/package.json',
        '{\n  "name": "myapp",\n  "version": "1.0.0",\n  "scripts": {\n    "start": "node src/index.js",\n    "test": "jest"\n  },\n  "dependencies": {\n    "express": "^4.18.0"\n  }\n}\n',
      ],
      [
        '/home/demo/projects/myapp/src/index.js',
        'const express = require("express");\nconst app = express();\n\napp.get("/", (req, res) => {\n  res.json({ message: "Hello, world!" });\n});\n\napp.listen(3000, () => {\n  console.log("Server running on port 3000");\n});\n',
      ],
      [
        '/home/demo/projects/myapp/README.md',
        '# MyApp\n\nA simple Express.js application.\n\n## Getting Started\n\n```bash\nnpm install\nnpm start\n```\n\nThe server will start on port 3000.\n',
      ],
      [
        '/home/demo/documents/notes.txt',
        'Meeting notes - 2024-01-15\n- Review Q4 metrics\n- Plan roadmap for Q1\n- Discuss hiring needs\n\nTODO:\n- Update documentation\n- Fix CI pipeline\n- Deploy v2.1\n',
      ],
      [
        '/home/demo/documents/todo.md',
        '# TODO List\n\n- [x] Set up project structure\n- [x] Implement core features\n- [ ] Write tests\n- [ ] Deploy to production\n- [ ] Monitor performance\n',
      ],
      ['/etc/hostname', 'tmuxy-demo\n'],
      ['/etc/os-release', 'NAME="Tmuxy Demo"\nVERSION="1.0"\nID=tmuxy\n'],
    ];
    for (const [path, content] of files) {
      this.nodes.set(path, {
        type: 'file',
        content,
        modified: now,
        permissions: '-rw-r--r--',
      });
    }
  }

  resolvePath(cwd: string, path: string): string {
    // Handle home directory
    const resolved = path.replace(/^~/, '/home/demo');
    // Make absolute
    const abs = resolved.startsWith('/') ? resolved : `${cwd}/${resolved}`;
    // Normalize
    const parts: string[] = [];
    for (const p of abs.split('/')) {
      if (p === '' || p === '.') continue;
      if (p === '..') {
        parts.pop();
      } else {
        parts.push(p);
      }
    }
    return '/' + parts.join('/');
  }

  exists(path: string): boolean {
    return this.nodes.has(path);
  }

  stat(path: string): VFSNode | null {
    return this.nodes.get(path) ?? null;
  }

  readFile(path: string): string | null {
    const node = this.nodes.get(path);
    if (!node || node.type !== 'file') return null;
    return node.content ?? '';
  }

  writeFile(path: string, content: string): void {
    this.nodes.set(path, {
      type: 'file',
      content,
      modified: Date.now(),
      permissions: '-rw-r--r--',
    });
  }

  readdir(path: string): string[] | null {
    const node = this.nodes.get(path);
    if (!node || node.type !== 'directory') return null;
    const prefix = path === '/' ? '/' : path + '/';
    const entries: string[] = [];
    for (const key of this.nodes.keys()) {
      if (key === path) continue;
      if (!key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      if (rest.includes('/')) continue; // not a direct child
      entries.push(rest);
    }
    return entries.sort();
  }

  mkdir(path: string, recursive = false): boolean {
    if (this.nodes.has(path)) return false;
    if (recursive) {
      const parts = path.split('/').filter(Boolean);
      let current = '';
      for (const part of parts) {
        current += '/' + part;
        if (!this.nodes.has(current)) {
          this.nodes.set(current, {
            type: 'directory',
            modified: Date.now(),
            permissions: 'drwxr-xr-x',
          });
        }
      }
      return true;
    }
    // Check parent exists
    const parent = path.substring(0, path.lastIndexOf('/')) || '/';
    const parentNode = this.nodes.get(parent);
    if (!parentNode || parentNode.type !== 'directory') return false;
    this.nodes.set(path, {
      type: 'directory',
      modified: Date.now(),
      permissions: 'drwxr-xr-x',
    });
    return true;
  }

  rm(path: string, recursive = false): boolean {
    const node = this.nodes.get(path);
    if (!node) return false;
    if (node.type === 'directory' && !recursive) {
      const children = this.readdir(path);
      if (children && children.length > 0) return false;
    }
    // Remove the node and all children
    const prefix = path === '/' ? '/' : path + '/';
    const toDelete = [path];
    if (recursive) {
      for (const key of this.nodes.keys()) {
        if (key.startsWith(prefix)) toDelete.push(key);
      }
    }
    for (const key of toDelete) this.nodes.delete(key);
    return true;
  }

  cp(src: string, dest: string): boolean {
    const node = this.nodes.get(src);
    if (!node || node.type !== 'file') return false;
    this.nodes.set(dest, { ...node, modified: Date.now() });
    return true;
  }

  mv(src: string, dest: string): boolean {
    const node = this.nodes.get(src);
    if (!node) return false;
    if (node.type === 'file') {
      this.nodes.set(dest, { ...node, modified: Date.now() });
      this.nodes.delete(src);
      return true;
    }
    // Move directory and all children
    const prefix = src === '/' ? '/' : src + '/';
    const toMove: [string, VFSNode][] = [[src, node]];
    for (const [key, val] of this.nodes) {
      if (key.startsWith(prefix)) {
        toMove.push([key, val]);
      }
    }
    for (const [key] of toMove) this.nodes.delete(key);
    for (const [key, val] of toMove) {
      const newKey = key === src ? dest : dest + key.slice(src.length);
      this.nodes.set(newKey, { ...val, modified: Date.now() });
    }
    return true;
  }
}
