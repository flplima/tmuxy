/**
 * Copy Last Output's last step: the text onto the clipboard, and what to say
 * once the browser has answered. The write comes a round trip after the
 * click, which Firefox and Safari may refuse, so "copied" is said only for a
 * write that took.
 */

import type { PaneId } from '../../domain/ids';
import { lastOutputNotice } from '../../domain/promptMarks';
import { clipboardBlockedMessage, writeClipboard } from '../../infra/clipboard';
import type { NotificationKind } from '../types/domain';

export async function copyLastOutput(
  text: string | null,
  paneId: PaneId,
): Promise<{ kind: NotificationKind; text: string }> {
  if (!text) return { kind: 'info', text: lastOutputNotice(text) };
  return (await writeClipboard(text, paneId))
    ? { kind: 'info', text: lastOutputNotice(text) }
    : { kind: 'error', text: clipboardBlockedMessage(text, paneId) };
}
