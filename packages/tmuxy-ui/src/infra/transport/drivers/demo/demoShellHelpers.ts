import { Sandbox } from '@lifo-sh/core';
import type { CellStyle, TerminalCell } from '../../../../domain/wire';

export const DEMO_BANNER_LINES = [
  '\x1b[1;36mThis is a live demo! \x1b[0m',
  'Running 100% client-side.',
  'Interactive shell powered by \x1b]8;;https://lifo.sh/\x07\x1b[1;33mlifo.sh\x1b[0m\x1b]8;;\x07',
  '',
];

export async function createDemoSandbox(): Promise<Sandbox> {
  return Sandbox.create({
    cwd: '/home/demo',
    env: {
      HOME: '/home/demo',
      USER: 'demo',
      SHELL: '/bin/bash',
      TERM: 'xterm-256color',
      PWD: '/home/demo',
      HOSTNAME: 'tmuxy',
    },
    files: {
      '/home/demo/.bashrc':
        '# ~/.bashrc\nexport PATH="$HOME/bin:$PATH"\nalias ll="ls -la"\nalias gs="git status"\n',
      '/home/demo/projects/myapp/package.json':
        '{\n  "name": "myapp",\n  "version": "1.0.0",\n  "scripts": {\n    "start": "node src/index.js",\n    "test": "jest"\n  },\n  "dependencies": {\n    "express": "^4.18.0"\n  }\n}\n',
      '/home/demo/projects/myapp/src/index.js':
        'const express = require("express");\nconst app = express();\n\napp.get("/", (req, res) => {\n  res.json({ message: "Hello, world!" });\n});\n\napp.listen(3000, () => {\n  console.log("Server running on port 3000");\n});\n',
      '/home/demo/projects/myapp/README.md':
        '# MyApp\n\nA simple Express.js application.\n\n## Getting Started\n\n```bash\nnpm install\nnpm start\n```\n\nThe server will start on port 3000.\n',
      '/home/demo/documents/notes.txt':
        'Meeting notes - 2024-01-15\n- Review Q4 metrics\n- Plan roadmap for Q1\n- Discuss hiring needs\n\nTODO:\n- Update documentation\n- Fix CI pipeline\n- Deploy v2.1\n',
      '/home/demo/documents/todo.md':
        '# TODO List\n\n- [x] Set up project structure\n- [x] Implement core features\n- [ ] Write tests\n- [ ] Deploy to production\n- [ ] Monitor performance\n',
      '/etc/hostname': 'tmuxy-demo\n',
      '/etc/os-release': 'NAME="Tmuxy Demo"\nVERSION="1.0"\nID=tmuxy\n',
      '/home/demo/pane-group-1.txt': 'Did you notice that this pane has two tabs?',
      '/home/demo/pane-group-2.txt':
        'A pane group lets you stack several panes in the same position within your layout. The inactive panes live in hidden tmux windows.\n\nWhen you switch tabs, tmuxy swaps the visible pane with the hidden one.\n',
    },
  });
}

/**
 * Is `ch` a CSI final byte? CSI sequences run `\x1b[` + parameter/intermediate
 * bytes + one final byte in the range 0x40-0x7E.
 */
export function isCsiFinal(ch: string): boolean {
  const code = ch.charCodeAt(0);
  return code >= 0x40 && code <= 0x7e;
}

export function parseSGR(params: string, current?: CellStyle): CellStyle | undefined {
  const codes = params.split(';').map(Number);
  const style: CellStyle = current ? { ...current } : {};

  for (let i = 0; i < codes.length; i++) {
    const code = codes[i];
    // Extended colour: 38/48 consume their arguments. `38;5;N` (256-colour)
    // and `38;2;R;G;B` (truecolour). Without this the trailing values were
    // read as standalone codes, so `38;5;31` set fg=1 from the `31`.
    if (code === 38 || code === 48) {
      const isFg = code === 38;
      const mode = codes[i + 1];
      if (mode === 5) {
        const n = codes[i + 2];
        if (Number.isFinite(n)) {
          if (isFg) style.fg = n;
          else style.bg = n;
        }
        i += 2;
      } else if (mode === 2) {
        // Truecolour isn't representable in CellStyle's palette index;
        // skip the three components rather than misreading them.
        i += 4;
      }
      continue;
    }
    if (code === 0) return undefined;
    if (code === 1) style.bold = true;
    if (code === 3) style.italic = true;
    if (code === 4) style.underline = true;
    if (code === 7) style.inverse = true;
    if (code >= 30 && code <= 37) style.fg = code - 30;
    if (code >= 40 && code <= 47) style.bg = code - 40;
    if (code >= 90 && code <= 97) style.fg = code - 90 + 8;
  }
  return Object.keys(style).length > 0 ? style : undefined;
}

export function writeAnsiText(text: string, writeCell: (cell: TerminalCell) => void): void {
  let i = 0;
  let currentStyle: CellStyle | undefined;
  let currentUrl: string | undefined;

  while (i < text.length) {
    // OSC 8 hyperlink: \x1b]8;params;url\x1b\\ or \x1b]8;params;url\x07
    if (text[i] === '\x1b' && text[i + 1] === ']' && text[i + 2] === '8' && text[i + 3] === ';') {
      // Find the params;url portion, terminated by ST (\x1b\\) or BEL (\x07)
      let j = i + 4;
      while (j < text.length) {
        if (text[j] === '\x07') break;
        if (text[j] === '\x1b' && text[j + 1] === '\\') break;
        j++;
      }
      const payload = text.slice(i + 4, j);
      const semiIdx = payload.indexOf(';');
      const url = semiIdx >= 0 ? payload.slice(semiIdx + 1) : payload;
      currentUrl = url || undefined; // empty url = close hyperlink
      // Skip past the terminator
      i = text[j] === '\x1b' ? j + 2 : j + 1;
      continue;
    }
    // CSI sequences (SGR, etc.). Terminate at the first byte in the CSI
    // final range (0x40-0x7E) and ignore finals we don't implement.
    // Scanning only for 'm'/'J'/'H' ran straight past common sequences like
    // \x1b[K, \x1b[1A and \x1b[?25l, consuming ordinary text until the next
    // literal m/J/H anywhere in the string and silently dropping it.
    if (text[i] === '\x1b' && text[i + 1] === '[') {
      let j = i + 2;
      while (j < text.length && !isCsiFinal(text[j])) j++;
      if (j < text.length) {
        if (text[j] === 'm') {
          currentStyle = parseSGR(text.slice(i + 2, j), currentStyle);
        }
        i = j + 1;
        continue;
      }
    }
    const s: CellStyle | undefined =
      currentStyle || currentUrl
        ? { ...currentStyle, ...(currentUrl ? { url: currentUrl } : {}) }
        : undefined;
    writeCell({ c: text[i], s });
    i++;
  }
}
