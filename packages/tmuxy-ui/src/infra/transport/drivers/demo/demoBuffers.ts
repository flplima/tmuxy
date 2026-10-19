/** tmux's named paste buffers (`set-buffer -b`), which a paste travels through. */
export class DemoBuffers {
  private readonly buffers = new Map<string, string>();

  /** `set-buffer [-a] -b name`: replace a buffer, or append to it. */
  set(name: string, text: string, append: boolean): void {
    this.buffers.set(name, (append ? (this.buffers.get(name) ?? '') : '') + text);
  }

  /** A buffer's text, dropped from the store when `remove` (`paste-buffer -d`). */
  read(name: string, remove: boolean): string | undefined {
    const text = this.buffers.get(name);
    if (remove) this.buffers.delete(name);
    return text;
  }
}
