// Batching constants
const KEY_BATCH_INTERVAL_MS = 16; // Batch keystrokes within ~1 frame

/**
 * Escape text for use with tmux send-keys -l (literal mode).
 * Wraps in single quotes, escaping internal single quotes.
 */
export function escapeLiteralText(text: string): string {
  return "'" + text.replace(/'/g, "'\\''") + "'";
}

/**
 * Unescape literal text from tmux send-keys -l format.
 * Reverses: 'text' → text, 'it'\''s' → it's
 */
export function unescapeLiteralText(escaped: string): string {
  if (!escaped.startsWith("'")) return escaped;
  let result = '';
  let i = 1; // skip opening quote
  while (i < escaped.length) {
    if (escaped[i] === "'" && escaped.substring(i, i + 4) === "'\\''" && i + 4 <= escaped.length) {
      result += "'";
      i += 4;
    } else if (escaped[i] === "'") {
      break;
    } else {
      result += escaped[i];
      i++;
    }
  }
  return result;
}

/**
 * Function signature for sending a fire-and-forget command.
 */
export type SendFn = (cmd: string, args: Record<string, unknown>) => void;

/**
 * KeyBatcher batches tmux send-keys commands within ~1 frame (16ms)
 * to reduce the number of round-trips to the backend.
 *
 * It handles two types of send-keys:
 * - Literal text: `send-keys -t SESSION -l 'TEXT'`
 * - Special keys: `send-keys -t SESSION KEY1 KEY2`
 *
 * Cross-batch ordering is preserved: if literal text is pending and a
 * special key arrives (or vice versa), the pending batch is flushed first.
 */
export class KeyBatcher {
  private pendingKeys: Map<string, string[]> = new Map();
  private keyBatchTimeout: ReturnType<typeof setTimeout> | null = null;
  private pendingLiteralText: Map<string, string> = new Map();
  private literalBatchTimeout: ReturnType<typeof setTimeout> | null = null;
  private sendFn: SendFn;

  constructor(sendFn: SendFn) {
    this.sendFn = sendFn;
  }

  /**
   * Try to intercept a command for batching.
   * Returns true if the command was intercepted (caller should return immediately).
   * Returns false if the command should be sent normally.
   */
  intercept(cmd: string, args?: Record<string, unknown>): boolean {
    if (cmd !== 'run_tmux_command' || !args?.command) return false;

    const command = args.command as string;

    // Match literal send-keys: send-keys -t SESSION -l 'ESCAPED_TEXT'
    const literalMatch = command.match(/^send-keys -t (\S+) -l (.+)$/);
    if (literalMatch) {
      const [, session, escapedText] = literalMatch;
      const rawText = unescapeLiteralText(escapedText);

      // Cross-batch ordering: flush pending special keys for this session first
      if (this.pendingKeys.has(session) && this.pendingKeys.get(session)!.length > 0) {
        this.flushKeyBatchForSession(session);
      }

      const existing = this.pendingLiteralText.get(session) || '';
      this.pendingLiteralText.set(session, existing + rawText);

      if (!this.literalBatchTimeout) {
        this.literalBatchTimeout = setTimeout(
          () => this.flushLiteralBatch(),
          KEY_BATCH_INTERVAL_MS,
        );
      }

      return true;
    }

    // Match special (non-literal) send-keys: send-keys -t SESSION KEYS
    const sendKeysMatch = command.match(/^send-keys -t (\S+) (?!-l )(.+)$/);
    if (sendKeysMatch) {
      const [, session, keys] = sendKeysMatch;

      // Cross-batch ordering: flush pending literal text for this session first
      if (
        this.pendingLiteralText.has(session) &&
        this.pendingLiteralText.get(session)!.length > 0
      ) {
        this.flushLiteralBatchForSession(session);
      }

      if (!this.pendingKeys.has(session)) {
        this.pendingKeys.set(session, []);
      }
      this.pendingKeys.get(session)!.push(keys);

      if (!this.keyBatchTimeout) {
        this.keyBatchTimeout = setTimeout(() => this.flushKeyBatch(), KEY_BATCH_INTERVAL_MS);
      }

      return true;
    }

    return false;
  }

  /**
   * Flush all pending batches. Call before sending non-batched commands.
   */
  flushAll(): void {
    if (this.keyBatchTimeout) {
      clearTimeout(this.keyBatchTimeout);
      this.keyBatchTimeout = null;
    }
    if (this.literalBatchTimeout) {
      clearTimeout(this.literalBatchTimeout);
      this.literalBatchTimeout = null;
    }

    for (const [session, keys] of this.pendingKeys) {
      if (keys.length === 0) continue;
      const combinedKeys = keys.join(' ');
      const command = `send-keys -t ${session} ${combinedKeys}`;
      this.sendFn('run_tmux_command', { command });
    }
    this.pendingKeys.clear();

    for (const [session, text] of this.pendingLiteralText) {
      if (text.length === 0) continue;
      const escaped = escapeLiteralText(text);
      const command = `send-keys -t ${session} -l ${escaped}`;
      this.sendFn('run_tmux_command', { command });
    }
    this.pendingLiteralText.clear();
  }

  /**
   * Clear all pending batches and timers without flushing.
   */
  destroy(): void {
    if (this.keyBatchTimeout) {
      clearTimeout(this.keyBatchTimeout);
      this.keyBatchTimeout = null;
    }
    if (this.literalBatchTimeout) {
      clearTimeout(this.literalBatchTimeout);
      this.literalBatchTimeout = null;
    }
    this.pendingKeys.clear();
    this.pendingLiteralText.clear();
  }

  private flushKeyBatch(): void {
    this.keyBatchTimeout = null;
    for (const [session, keys] of this.pendingKeys) {
      if (keys.length === 0) continue;
      const combinedKeys = keys.join(' ');
      const command = `send-keys -t ${session} ${combinedKeys}`;
      this.sendFn('run_tmux_command', { command });
    }
    this.pendingKeys.clear();
  }

  private flushKeyBatchForSession(session: string): void {
    const keys = this.pendingKeys.get(session);
    if (!keys || keys.length === 0) return;
    const combinedKeys = keys.join(' ');
    const command = `send-keys -t ${session} ${combinedKeys}`;
    this.sendFn('run_tmux_command', { command });
    this.pendingKeys.delete(session);
  }

  private flushLiteralBatch(): void {
    this.literalBatchTimeout = null;
    for (const [session, text] of this.pendingLiteralText) {
      if (text.length === 0) continue;
      const escaped = escapeLiteralText(text);
      const command = `send-keys -t ${session} -l ${escaped}`;
      this.sendFn('run_tmux_command', { command });
    }
    this.pendingLiteralText.clear();
  }

  private flushLiteralBatchForSession(session: string): void {
    const text = this.pendingLiteralText.get(session);
    if (!text || text.length === 0) return;
    const escaped = escapeLiteralText(text);
    const command = `send-keys -t ${session} -l ${escaped}`;
    this.sendFn('run_tmux_command', { command });
    this.pendingLiteralText.delete(session);
  }
}
