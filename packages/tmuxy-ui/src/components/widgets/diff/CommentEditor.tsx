/**
 * Writing one line's comment: a text box, Save and Cancel. Ctrl/Cmd+Enter
 * saves, Escape cancels; neither reaches the pane.
 */

import { useState, type KeyboardEvent } from 'react';

export function CommentEditor({
  initial,
  onSave,
  onCancel,
}: {
  initial: string;
  onSave: (body: string) => void;
  onCancel: () => void;
}) {
  const [body, setBody] = useState(initial);
  const save = () => {
    if (body.trim()) onSave(body);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      e.stopPropagation();
      save();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onCancel();
    }
  };
  return (
    <div className="diff-comment-editor" data-diff-comment-editor="">
      <textarea
        aria-label="Comment"
        value={body}
        rows={3}
        autoFocus
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <div className="diff-comment-actions">
        <button type="button" onClick={save} disabled={!body.trim()}>
          Save
        </button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
