/**
 * One file of a diff: its name, status and counts, then its hunks, each line
 * with its old and new numbers. Everything here is the checkout's text, put
 * on screen as text nodes only.
 */

import { memo } from 'react';
import { fileCounts, type DiffFile, type DiffLine } from '../../../domain/diff';

const SIGN: Record<DiffLine['kind'], string> = {
  context: ' ',
  added: '+',
  removed: '-',
  note: '\\',
};

const STATUS_LABEL: Record<DiffFile['status'], string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
};

function Line({ line }: { line: DiffLine }) {
  return (
    <div className={`diff-line is-${line.kind}`} data-diff-line={line.kind}>
      <span className="diff-no diff-no-old">{line.old ?? ''}</span>
      <span className="diff-no diff-no-new">{line.new ?? ''}</span>
      <span className="diff-sign" aria-hidden="true">
        {SIGN[line.kind]}
      </span>
      <span className="diff-text">{line.text}</span>
    </div>
  );
}

export const DiffFileView = memo(function DiffFileView({
  file,
  open,
  onToggle,
}: {
  file: DiffFile;
  open: boolean;
  onToggle: (path: string) => void;
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
              <div className="diff-hunk-header">{hunk.header}</div>
              {hunk.lines.map((line, at) => (
                <Line line={line} key={at} />
              ))}
            </div>
          ))}
        </div>
      )}
    </section>
  );
});
