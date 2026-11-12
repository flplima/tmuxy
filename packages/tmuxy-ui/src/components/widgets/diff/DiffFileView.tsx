/**
 * One file of a diff: its name, status and counts, then its hunks, each line
 * with its old and new numbers. Everything here is the checkout's text, put
 * on screen as text nodes only.
 */

import { memo } from 'react';
import { fileCounts, LINE_SIGN, type DiffFile, type DiffLine } from '../../../domain/diff';
import { HunkBar } from './HunkBar';
import type { HunkControls } from './useHunks';
import { commentKey, type LineSide, type ReviewComment } from '../../../domain/review';
import { CommentEditor } from './CommentEditor';

/** The review's comments and the one being written, with what changes them. */
export interface FileReview {
  comments: ReadonlyMap<string, ReviewComment>;
  editing: string | null;
  edit: (key: string | null) => void;
  save: (key: string, comment: ReviewComment | null) => void;
}

/** Where a line is commented on: its new number, or its old one when it was removed. */
function anchor(line: DiffLine): { side: LineSide; line: number } | null {
  if (line.new != null) return { side: 'new', line: line.new };
  if (line.old != null) return { side: 'old', line: line.old };
  return null;
}

const STATUS_LABEL: Record<DiffFile['status'], string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
};

/** What goes under a commented line: its comment, or the box it is written in. */
function LineNote({
  at,
  commentKey: key,
  path,
  code,
  review,
}: {
  at: { side: LineSide; line: number };
  commentKey: string;
  path: string;
  code: string;
  review: FileReview;
}) {
  const comment = review.comments.get(key);
  if (review.editing === key) {
    return (
      <CommentEditor
        initial={comment?.body ?? ''}
        onCancel={() => review.edit(null)}
        onSave={(body) => review.save(key, { path, side: at.side, line: at.line, code, body })}
      />
    );
  }
  if (!comment) return null;
  return (
    <div className="diff-comment" data-diff-comment="">
      <span className="diff-comment-body">{comment.body}</span>
      <button type="button" onClick={() => review.edit(key)}>
        Edit
      </button>
      <button type="button" onClick={() => review.save(key, null)}>
        Delete
      </button>
    </div>
  );
}

function Line({ path, line, review }: { path: string; line: DiffLine; review: FileReview }) {
  const at = anchor(line);
  const key = at ? commentKey(path, at.side, at.line) : null;
  return (
    <>
      <div className={`diff-line is-${line.kind}`} data-diff-line={line.kind}>
        {at && key ? (
          <button
            type="button"
            className="diff-comment-add"
            aria-label={`Comment on ${path} ${at.side === 'old' ? 'removed ' : ''}line ${at.line}`}
            onClick={() => review.edit(key)}
          >
            +
          </button>
        ) : (
          <span className="diff-comment-add" />
        )}
        <span className="diff-no diff-no-old">{line.old ?? ''}</span>
        <span className="diff-no diff-no-new">{line.new ?? ''}</span>
        <span className="diff-sign" aria-hidden="true">
          {LINE_SIGN[line.kind]}
        </span>
        <span className="diff-text">{line.text}</span>
      </div>
      {at && key && (
        <LineNote at={at} commentKey={key} path={path} code={line.text} review={review} />
      )}
    </>
  );
}

export const DiffFileView = memo(function DiffFileView({
  file,
  open,
  onToggle,
  review,
  hunks,
}: {
  file: DiffFile;
  open: boolean;
  onToggle: (path: string) => void;
  review: FileReview;
  hunks: HunkControls;
}) {
  const { added, removed } = fileCounts(file);
  return (
    <section className="diff-file" data-diff-file={file.path}>
      <button
        type="button"
        className="diff-file-header"
        aria-expanded={open}
        onClick={() => onToggle(file.path)}
      >
        <span className={`diff-status is-${file.status}`} title={file.status}>
          {STATUS_LABEL[file.status]}
        </span>
        <span className="diff-path">
          {file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
        </span>
        <span className="diff-counts">
          {added > 0 && <span className="diff-added">+{added}</span>}
          {removed > 0 && <span className="diff-removed">−{removed}</span>}
        </span>
      </button>
      {open && (
        <div className="diff-file-body">
          {file.modeChange && <div className="diff-note">mode {file.modeChange}</div>}
          {file.binary && <div className="diff-note">Binary file: no lines to show</div>}
          {file.hunks.map((hunk, index) => (
            <div className="diff-hunk" key={`${index}:${hunk.header}`}>
              <HunkBar file={file} hunk={hunk} index={index} controls={hunks} />
              {hunk.lines.map((line, at) => (
                <Line path={file.path} line={line} review={review} key={at} />
              ))}
            </div>
          ))}
        </div>
      )}
    </section>
  );
});
