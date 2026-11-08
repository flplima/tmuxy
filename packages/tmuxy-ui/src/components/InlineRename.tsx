/**
 * Renames a tab or a pane in place. Blur commits rather than discards: clicking
 * away is what people do when they think they are finished, and an accidental
 * rename is one rename away from fixed, where a lost name is not.
 *
 * The keyboard actor leaves form controls alone (it checks the event's
 * target); the pointer handlers keep a click in the field from also selecting
 * the tab or pane underneath it.
 */

import { useEffect, useRef, useState } from 'react';

interface InlineRenameProps {
  /** What it is called now; the field opens with this, selected. */
  value: string;
  /** The new name, already trimmed. Not called when nothing changed. */
  onCommit: (name: string) => void;
  onCancel: () => void;
  ariaLabel: string;
  className?: string;
  testId?: string;
}

export function InlineRename({
  value,
  onCommit,
  onCancel,
  ariaLabel,
  className,
  testId,
}: InlineRenameProps) {
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);
  // The blur that follows a commit or a cancel must not finish a second time.
  const doneRef = useRef(false);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    input.select();
  }, []);

  const finish = (commit: boolean) => {
    if (doneRef.current) return;
    doneRef.current = true;
    const name = draft.trim();
    if (commit && name && name !== value) onCommit(name);
    else onCancel();
  };

  return (
    <input
      ref={inputRef}
      className={className ? `inline-rename ${className}` : 'inline-rename'}
      type="text"
      value={draft}
      aria-label={ariaLabel}
      data-testid={testId ?? 'inline-rename'}
      spellCheck={false}
      autoComplete="off"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => finish(true)}
      onKeyDown={(e) => {
        // Every key belongs to the field, including the ones the app binds.
        e.stopPropagation();
        if (e.key === 'Enter') {
          e.preventDefault();
          finish(true);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          finish(false);
        }
      }}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
    />
  );
}
