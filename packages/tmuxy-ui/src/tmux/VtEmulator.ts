import type { PaneContent, TerminalCell, CellStyle } from './types';

/**
 * Minimal VT100/ANSI terminal emulator that maintains a cell grid
 * and produces structured PaneContent for tmuxy-ui.
 *
 * Handles the common sequences emitted by bash:
 * - SGR colors and attributes (256-color, truecolor)
 * - Cursor movement (H, A, B, C, D, E, F, G, d)
 * - Erase (J, K) and line insert/delete (L, M)
 * - Character insert/delete (@ , P)
 * - OSC sequences (title, etc.)
 * - Save/restore cursor (ESC 7/8, CSI s/u)
 */
export class VtEmulator {
  cols: number;
  rows: number;
  private cells: TerminalCell[][];
  private cursorX = 0;
  private cursorY = 0;
  private savedCursorX = 0;
  private savedCursorY = 0;
  private currentStyle: CellStyle = {};

  constructor(cols: number, rows: number) {
    this.cols = cols;
    this.rows = rows;
    this.cells = this.makeGrid(rows, cols);
  }

  resize(cols: number, rows: number): void {
    const newCells = this.makeGrid(rows, cols);
    for (let r = 0; r < Math.min(rows, this.rows); r++) {
      for (let c = 0; c < Math.min(cols, this.cols); c++) {
        newCells[r][c] = this.cells[r][c];
      }
    }
    this.cols = cols;
    this.rows = rows;
    this.cells = newCells;
    this.cursorX = Math.min(this.cursorX, cols - 1);
    this.cursorY = Math.min(this.cursorY, rows - 1);
  }

  write(data: string): void {
    let i = 0;
    while (i < data.length) {
      const ch = data[i];
      if (ch === '\x1b') {
        i = this.parseEscape(data, i);
      } else if (ch === '\r') {
        this.cursorX = 0;
        i++;
      } else if (ch === '\n') {
        this.lineFeed();
        i++;
      } else if (ch === '\t') {
        this.cursorX = Math.min(((this.cursorX >> 3) + 1) << 3, this.cols - 1);
        i++;
      } else if (ch === '\x08') {
        if (this.cursorX > 0) this.cursorX--;
        i++;
      } else if (ch === '\x07' || ch === '\x00') {
        i++;
      } else if (ch >= ' ') {
        this.putChar(ch);
        i++;
      } else {
        i++;
      }
    }
  }

  getCells(): PaneContent {
    return this.cells.map((row) => [...row]);
  }

  getCursor(): { x: number; y: number } {
    return { x: this.cursorX, y: this.cursorY };
  }

  private makeGrid(rows: number, cols: number): TerminalCell[][] {
    return Array.from({ length: rows }, () => Array.from({ length: cols }, () => ({ c: ' ' })));
  }

  private emptyRow(): TerminalCell[] {
    return Array.from({ length: this.cols }, () => ({ c: ' ' }));
  }

  private lineFeed(): void {
    this.cursorY++;
    if (this.cursorY >= this.rows) {
      this.cells.shift();
      this.cells.push(this.emptyRow());
      this.cursorY = this.rows - 1;
    }
  }

  private putChar(ch: string): void {
    if (this.cursorX < this.cols && this.cursorY < this.rows) {
      const style =
        Object.keys(this.currentStyle).length > 0 ? { ...this.currentStyle } : undefined;
      this.cells[this.cursorY][this.cursorX] = style ? { c: ch, s: style } : { c: ch };
    }
    this.cursorX++;
    if (this.cursorX >= this.cols) {
      this.cursorX = 0;
      this.lineFeed();
    }
  }

  private parseEscape(data: string, i: number): number {
    i++; // skip ESC
    if (i >= data.length) return i;

    const next = data[i];

    if (next === '[') {
      // CSI sequence
      i++;
      let params = '';
      // Collect parameter and intermediate bytes (0x30–0x3f and 0x20–0x2f)
      while (i < data.length && data.charCodeAt(i) >= 0x30 && data.charCodeAt(i) <= 0x3f) {
        params += data[i++];
      }
      while (i < data.length && data.charCodeAt(i) >= 0x20 && data.charCodeAt(i) <= 0x2f) {
        i++; // skip intermediate bytes
      }
      if (i < data.length) {
        const cmd = data[i++];
        this.handleCSI(params, cmd);
      }
    } else if (next === ']') {
      // OSC – read until ST (ESC \) or BEL
      i++;
      while (i < data.length) {
        if (data[i] === '\x07') {
          i++;
          break;
        }
        if (data[i] === '\x1b' && data[i + 1] === '\\') {
          i += 2;
          break;
        }
        i++;
      }
    } else if (next === '(' || next === ')' || next === '*' || next === '+') {
      i += 2; // Charset designations – skip one more char
    } else if (next === '7') {
      this.savedCursorX = this.cursorX;
      this.savedCursorY = this.cursorY;
      i++;
    } else if (next === '8') {
      this.cursorX = this.savedCursorX;
      this.cursorY = this.savedCursorY;
      i++;
    } else if (next === 'M') {
      // Reverse index
      if (this.cursorY > 0) this.cursorY--;
      i++;
    } else if (next === 'c') {
      // RIS – full reset
      this.cells = this.makeGrid(this.rows, this.cols);
      this.cursorX = 0;
      this.cursorY = 0;
      this.currentStyle = {};
      i++;
    } else {
      i++;
    }

    return i;
  }

  private handleCSI(params: string, cmd: string): void {
    const privateMode = params.startsWith('?');
    const rawParams = privateMode ? params.slice(1) : params;
    const nums = rawParams.split(';').map((p) => (p === '' ? 0 : parseInt(p, 10)));
    const p1 = nums[0] ?? 0;
    const p2 = nums[1] ?? 0;

    switch (cmd) {
      case 'H':
      case 'f':
        this.cursorY = Math.max(0, Math.min((p1 || 1) - 1, this.rows - 1));
        this.cursorX = Math.max(0, Math.min((p2 || 1) - 1, this.cols - 1));
        break;
      case 'A':
        this.cursorY = Math.max(0, this.cursorY - (p1 || 1));
        break;
      case 'B':
        this.cursorY = Math.min(this.rows - 1, this.cursorY + (p1 || 1));
        break;
      case 'C':
        this.cursorX = Math.min(this.cols - 1, this.cursorX + (p1 || 1));
        break;
      case 'D':
        this.cursorX = Math.max(0, this.cursorX - (p1 || 1));
        break;
      case 'E':
        this.cursorY = Math.min(this.rows - 1, this.cursorY + (p1 || 1));
        this.cursorX = 0;
        break;
      case 'F':
        this.cursorY = Math.max(0, this.cursorY - (p1 || 1));
        this.cursorX = 0;
        break;
      case 'G':
        this.cursorX = Math.max(0, Math.min((p1 || 1) - 1, this.cols - 1));
        break;
      case 'd':
        this.cursorY = Math.max(0, Math.min((p1 || 1) - 1, this.rows - 1));
        break;
      case 's':
        this.savedCursorX = this.cursorX;
        this.savedCursorY = this.cursorY;
        break;
      case 'u':
        this.cursorX = this.savedCursorX;
        this.cursorY = this.savedCursorY;
        break;
      case 'J': {
        if (p1 === 2 || p1 === 3) {
          this.cells = this.makeGrid(this.rows, this.cols);
          this.cursorX = 0;
          this.cursorY = 0;
        } else if (p1 === 0) {
          for (let x = this.cursorX; x < this.cols; x++) this.cells[this.cursorY][x] = { c: ' ' };
          for (let y = this.cursorY + 1; y < this.rows; y++) this.cells[y] = this.emptyRow();
        } else if (p1 === 1) {
          for (let y = 0; y < this.cursorY; y++) this.cells[y] = this.emptyRow();
          for (let x = 0; x <= this.cursorX; x++) this.cells[this.cursorY][x] = { c: ' ' };
        }
        break;
      }
      case 'K': {
        if (p1 === 0) {
          for (let x = this.cursorX; x < this.cols; x++) this.cells[this.cursorY][x] = { c: ' ' };
        } else if (p1 === 1) {
          for (let x = 0; x <= this.cursorX; x++) this.cells[this.cursorY][x] = { c: ' ' };
        } else if (p1 === 2) {
          this.cells[this.cursorY] = this.emptyRow();
        }
        break;
      }
      case 'P': {
        const n = p1 || 1;
        this.cells[this.cursorY].splice(this.cursorX, n);
        while (this.cells[this.cursorY].length < this.cols)
          this.cells[this.cursorY].push({ c: ' ' });
        break;
      }
      case '@': {
        const n = p1 || 1;
        this.cells[this.cursorY].splice(
          this.cursorX,
          0,
          ...Array.from({ length: n }, () => ({ c: ' ' }) as TerminalCell),
        );
        this.cells[this.cursorY].length = this.cols;
        break;
      }
      case 'L': {
        const n = p1 || 1;
        for (let li = 0; li < n; li++) {
          this.cells.splice(this.cursorY, 0, this.emptyRow());
          this.cells.pop();
        }
        break;
      }
      case 'M': {
        const n = p1 || 1;
        for (let li = 0; li < n; li++) {
          this.cells.splice(this.cursorY, 1);
          this.cells.push(this.emptyRow());
        }
        break;
      }
      case 'm':
        this.handleSGR(nums.length === 0 ? [0] : nums);
        break;
      default:
        break;
    }
  }

  private handleSGR(nums: number[]): void {
    let i = 0;
    while (i < nums.length) {
      const n = nums[i];
      if (n === 0) {
        this.currentStyle = {};
      } else if (n === 1) {
        this.currentStyle = { ...this.currentStyle, bold: true };
      } else if (n === 3) {
        this.currentStyle = { ...this.currentStyle, italic: true };
      } else if (n === 4) {
        this.currentStyle = { ...this.currentStyle, underline: true };
      } else if (n === 7) {
        this.currentStyle = { ...this.currentStyle, inverse: true };
      } else if (n === 22) {
        const { bold: _b, ...rest } = this.currentStyle;
        this.currentStyle = rest;
      } else if (n === 23) {
        const { italic: _i, ...rest } = this.currentStyle;
        this.currentStyle = rest;
      } else if (n === 24) {
        const { underline: _u, ...rest } = this.currentStyle;
        this.currentStyle = rest;
      } else if (n === 27) {
        const { inverse: _v, ...rest } = this.currentStyle;
        this.currentStyle = rest;
      } else if (n >= 30 && n <= 37) {
        this.currentStyle = { ...this.currentStyle, fg: n - 30 };
      } else if (n === 38) {
        if (nums[i + 1] === 5 && i + 2 < nums.length) {
          this.currentStyle = { ...this.currentStyle, fg: nums[i + 2] };
          i += 2;
        } else if (nums[i + 1] === 2 && i + 4 < nums.length) {
          this.currentStyle = {
            ...this.currentStyle,
            fg: { r: nums[i + 2], g: nums[i + 3], b: nums[i + 4] },
          };
          i += 4;
        }
      } else if (n === 39) {
        const { fg: _f, ...rest } = this.currentStyle;
        this.currentStyle = rest;
      } else if (n >= 40 && n <= 47) {
        this.currentStyle = { ...this.currentStyle, bg: n - 40 };
      } else if (n === 48) {
        if (nums[i + 1] === 5 && i + 2 < nums.length) {
          this.currentStyle = { ...this.currentStyle, bg: nums[i + 2] };
          i += 2;
        } else if (nums[i + 1] === 2 && i + 4 < nums.length) {
          this.currentStyle = {
            ...this.currentStyle,
            bg: { r: nums[i + 2], g: nums[i + 3], b: nums[i + 4] },
          };
          i += 4;
        }
      } else if (n === 49) {
        const { bg: _bg, ...rest } = this.currentStyle;
        this.currentStyle = rest;
      } else if (n >= 90 && n <= 97) {
        this.currentStyle = { ...this.currentStyle, fg: n - 90 + 8 };
      } else if (n >= 100 && n <= 107) {
        this.currentStyle = { ...this.currentStyle, bg: n - 100 + 8 };
      }
      i++;
    }
  }
}
