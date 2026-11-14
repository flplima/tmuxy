/**
 * A hunk's actions, on its header: Stage and Revert… in the unstaged
 * changes, Unstage in the staged ones. Revert asks first, with the hunk it
 * throws away in front of you, and says it can be undone.
 */

import { hunkActions, LINE_SIGN, type DiffFile, type DiffHunk } from '../../../domain/diff';
import type { HunkControls } from './useHunks';

const LABEL = { stage: 'Stage', unstage: 'Unstage', revert: 'Revert…' } as const;

export function HunkBar({
  file,
  hunk,
  index,
  controls,
}: {
  file: DiffFile;
  hunk: DiffHunk;
  index: number;
  controls: HunkControls;
}) {
  const actions = hunkActions(controls.scope, file);
  const asked = controls.confirming;
  const confirming = asked?.path === file.path && asked.hunk === index;
  return (
    <>
      <div className="diff-hunk-header">
        <span className="diff-hunk-range">{hunk.header}</span>
        {actions.map((action) => (
          <button
            type="button"
            key={action}
            className={`diff-hunk-action is-${action}`}
            aria-label={`${LABEL[action]} hunk ${index + 1} of ${file.path}`}
            onClick={() => controls.act(file, index, action)}
          >
            {LABEL[action]}
          </button>
        ))}
      </div>
      {confirming && (
        <div className="diff-revert-confirm" role="alertdialog" aria-label="Revert this hunk?">
          <div className="diff-revert-question">
            Throw away this change to {file.path}? tmuxy keeps a copy, so you can undo it.
          </div>
          <pre className="diff-revert-hunk">
            {hunk.lines.map((line) => `${LINE_SIGN[line.kind]}${line.text}`).join('\n')}
          </pre>
          <div className="diff-comment-actions">
            <button type="button" className="diff-revert-yes" onClick={controls.confirm}>
              Revert this hunk
            </button>
            <button type="button" onClick={controls.cancel}>
              Keep it
            </button>
          </div>
        </div>
      )}
    </>
  );
}
