/**
 * The guest's serial line as the machine's worker drives it, both ways: what
 * the guest prints is gathered into one chunk per burst before it crosses to
 * the page, and what the page sends is fed to the UART at a pace the guest
 * keeps up with. Plain classes over the timers, so they are tested without a
 * worker.
 */

/** How long a burst of the guest's output is gathered before it crosses. */
export const SERIAL_FLUSH_MS = 8;

/**
 * v86 emits serial output one byte at a time; one message per byte would
 * cost the page a task per byte. Bytes are gathered from the first one of a
 * burst for `SERIAL_FLUSH_MS`, then handed on as one chunk the receiver may
 * keep (it is transferred, so each chunk is a fresh buffer).
 */
export class SerialCollector {
  private buffer = new Uint8Array(4096);
  private length = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly flush: (chunk: Uint8Array) => void) {}

  push(byte: number): void {
    if (this.length === this.buffer.length) {
      const grown = new Uint8Array(this.buffer.length * 2);
      grown.set(this.buffer);
      this.buffer = grown;
    }
    this.buffer[this.length++] = byte;
    this.timer ??= setTimeout(() => this.emit(), SERIAL_FLUSH_MS);
  }

  /** Forget what was gathered: the machine that printed it is being rewound. */
  clear(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.length = 0;
  }

  private emit(): void {
    this.timer = null;
    const chunk = this.buffer.slice(0, this.length);
    this.length = 0;
    this.flush(chunk);
  }
}

/**
 * Bytes are fed to the guest UART in chunks, paced under the rate the guest
 * drains them. v86's UART holds received bytes in an unbounded queue and
 * keeps the interrupt raised until the guest has read them all, so no chunk
 * size overruns it; what bounds the rate is the guest itself, which reads
 * ~45 KB/s (1,500 marker commands — 46 KB — all answered in order, at every
 * pacing up to 128 KB/s). Staying under that keeps the kernel's tty buffer
 * from filling behind a burst; a pace far below it (2 KB/s) queued seconds of
 * backlog behind a burst of splits and timed tracked commands out.
 */
export const CHUNK_BYTES = 128;
export const CHUNK_INTERVAL_MS = 4;

/** v86's `serial0_send` writes one byte per JS char (its code & 0xFF). */
export function byteString(bytes: Uint8Array): string {
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(byte);
  return text;
}

export class PacedWriter {
  private pending = '';
  private writing = false;

  constructor(private readonly write: (bytes: string) => void) {}

  push(bytes: Uint8Array): void {
    this.pending += byteString(bytes);
    this.drain();
  }

  /** Drop what is still queued: it was meant for a machine being rewound. */
  clear(): void {
    this.pending = '';
  }

  private drain(): void {
    if (this.writing || this.pending.length === 0) return;
    this.writing = true;
    const chunk = this.pending.slice(0, CHUNK_BYTES);
    this.pending = this.pending.slice(chunk.length);
    this.write(chunk);
    setTimeout(() => {
      this.writing = false;
      this.drain();
    }, CHUNK_INTERVAL_MS);
  }
}
