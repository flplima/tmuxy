/**
 * InlineRename — renaming a thing where the thing is, rather than in a prompt.
 *
 * A tab and a pane both get their names changed the same way: the label turns
 * into a field holding what it already says, selected, so typing replaces it
 * and Enter is the only key you need. Escape puts it back.
 *
 * Committing on blur rather than discarding is deliberate: clicking away is
 * what people do when they think they are finished, and losing the name they
 * just typed to a misplaced click is a worse outcome than an accidental
 * rename, which is itself a rename away from being fixed.
 *
 * The keyboard actor already leaves real form controls alone (it checks the
 * event's target), so what is typed here reaches the field rather than tmux;
 * the pointer handlers below are the other half of that, keeping a click in
 * the field from also selecting the tab or pane underneath it.
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
}

export function InlineRename({
  value,
  onCommit,
  onCancel,
  ariaLabel,
  className,
}: InlineRenameProps) {
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);
  // Whether the field has already had its say, so the blur that follows a
  // commit or a cancel does not have a second one.
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
      data-testid="inline-rename"
      spellCheck={false}
      autoComplete="off"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => finish(true)}
      onKeyDown={(e) => {
        // Every key belongs to the field, including the ones the app binds:
        // a rename is not the moment for prefix keys or tab switching.
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
