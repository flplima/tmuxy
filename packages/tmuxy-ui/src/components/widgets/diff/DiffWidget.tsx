/**
 * The `diff` widget (`tmuxy widget diff`): the changes of one git checkout,
 * in the scope the bar above them is switched to — unstaged, staged, the
 * branch against its base, or an agent's last turn. Read again every few seconds while the app is on
 * screen; the last read stays on screen meanwhile and beside a failure.
 */

import { useCallback, useMemo, useState } from 'react';
import type { WidgetProps } from '../registry';
import { DIFF_SCOPES, fileCounts, type DiffRead, type DiffScope } from '../../../domain/diff';
import { useAppSelector } from '../../../machines/appHooks';
import { selectPaneHoldsKeyboard } from '../../../machines/selectors/keyboard';
import { selectPhoneLayout } from '../../../machines/selectors/layout';
import { useSwallowedTyping } from '../useSwallowedTyping';
import { DiffFileView, type FileReview } from './DiffFileView';
import { ReviewBar } from './ReviewBar';
import { useHunks, type HunkControls } from './useHunks';
import type { ReviewComment } from '../../../domain/review';
import { useDiffRead } from './diffSource';
import './diff.css';

const SCOPE_LABEL: Record<DiffScope, string> = {
  unstaged: 'Unstaged',
  staged: 'Staged',
  branch: 'Branch',
  turn: 'Last turn',
};

function summary(read: DiffRead): string {
  let added = 0;
  let removed = 0;
  for (const file of read.files) {
    const counts = fileCounts(file);
    added += counts.added;
    removed += counts.removed;
  }
  const files = `${read.files.length} ${read.files.length === 1 ? 'file' : 'files'}`;
  return `${files} · +${added} −${removed}`;
}

/** What the read compares, in words: `feature against main`, `%3's last turn`, `main`. */
function compared(read: DiffRead): string | null {
  if (read.scope === 'branch' && read.base) return `${read.branch ?? 'HEAD'} against ${read.base}`;
  if (read.turn) {
    const { agent, ongoing } = read.turn;
    return ongoing ? `${agent}'s turn so far` : `${agent}'s last turn`;
  }
  return read.branch ?? null;
}

function DiffBar({
  scope,
  onScope,
  read,
  onRefresh,
}: {
  scope: DiffScope;
  onScope: (scope: DiffScope) => void;
  read: DiffRead | null;
  onRefresh: () => void;
}) {
  return (
    <div className="diff-bar">
      <div className="diff-scopes" role="tablist" aria-label="What to compare">
        {DIFF_SCOPES.map((each) => (
          <button
            key={each}
            type="button"
            role="tab"
            aria-selected={each === scope}
            className="diff-scope"
            data-diff-scope-tab={each}
            onClick={() => onScope(each)}
          >
            {SCOPE_LABEL[each]}
          </button>
        ))}
      </div>
      {read && <span className="diff-summary">{summary(read)}</span>}
      <button
        type="button"
        className="diff-refresh"
        aria-label="Read the changes again"
        onClick={onRefresh}
      >
        ⟳
      </button>
    </div>
  );
}

/** A list of file names under a title: untracked ones, or ones a turn left out. */
function Names({ title, names, more }: { title: string; names: readonly string[]; more: number }) {
  if (names.length === 0) return null;
  return (
    <section className="diff-untracked" data-diff-names={title}>
      <div className="diff-untracked-title">{title}</div>
      {names.map((name) => (
        <div className="diff-untracked-name" key={name}>
          {name}
        </div>
      ))}
      {more > 0 && <div className="diff-note">and {more} more</div>}
    </section>
  );
}

function DiffFiles({
  read,
  closed,
  onToggle,
  review,
  hunks,
}: {
  read: DiffRead;
  closed: ReadonlySet<string>;
  onToggle: (path: string) => void;
  review: FileReview;
  hunks: HunkControls;
}) {
  return (
    <div className="diff-files">
      {compared(read) && <div className="diff-compared">{compared(read)}</div>}
      {read.files.length === 0 && read.untracked.length === 0 && (
        <div className="diff-message">No changes</div>
      )}
      {read.files.map((file) => (
        <DiffFileView
          key={`${file.oldPath ?? ''}>${file.path}`}
          file={file}
          open={!closed.has(file.path)}
          onToggle={onToggle}
          review={review}
          hunks={hunks}
        />
      ))}
      <Names title="Not tracked by git" names={read.untracked} more={read.untrackedMore} />
      <Names title="Left out of this turn, not copied" names={read.turn?.leftOut ?? []} more={0} />
      {read.truncated && (
        <div className="diff-note">
          The changes are too large to show whole: this is their start.
        </div>
      )}
    </div>
  );
}

/**
 * The review being written: comments by line, kept across reads and scopes
 * until they are sent, and the one being edited.
 */
function useReview(): FileReview & {
  list: ReviewComment[];
  sent: () => void;
  restore: (() => void) | null;
} {
  const [comments, setComments] = useState<ReadonlyMap<string, ReviewComment>>(new Map());
  const [lastSent, setLastSent] = useState<ReadonlyMap<string, ReviewComment> | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  return useMemo(
    () => ({
      comments,
      editing,
      edit: setEditing,
      save: (key: string, comment: ReviewComment | null) => {
        setComments((was) => {
          const next = new Map(was);
          if (comment) next.set(key, comment);
          else next.delete(key);
          return next;
        });
        setEditing(null);
      },
      list: [...comments.values()],
      sent: () => {
        setLastSent(comments);
        setComments(new Map());
      },
      restore:
        lastSent && comments.size === 0
          ? () => {
              setComments(lastSent);
              setLastSent(null);
            }
          : null,
    }),
    [comments, lastSent, editing],
  );
}

export function DiffWidget({ paneId, lines }: WidgetProps) {
  const [scope, setScope] = useState<DiffScope>('unstaged');
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
  const review = useReview();
  const diff = useDiffRead(paneId, scope);
  const hunks = useHunks(paneId, scope, diff.refresh);
  const active = useAppSelector((ctx) => selectPaneHoldsKeyboard(ctx, paneId));
  const phone = useAppSelector(selectPhoneLayout);
  useSwallowedTyping(active);
  const toggle = useCallback(
    (path: string) =>
      setClosed((was) => {
        const next = new Set(was);
        if (!next.delete(path)) next.add(path);
        return next;
      }),
    [],
  );

  const read = diff.value?.scope === scope ? diff.value : null;
  return (
    <div className={`diff-widget${phone ? ' is-phone' : ''}`} data-diff-scope={scope}>
      <DiffBar scope={scope} onScope={setScope} read={read} onRefresh={diff.refresh} />
      {diff.error && <div className="diff-error">{diff.error}</div>}
      {!read && !diff.error && <div className="diff-message">Reading the changes…</div>}
      {hunks.lastRevert && (
        <div className="diff-undo" data-diff-undo="">
          <span>Reverted a hunk of {hunks.lastRevert.path}</span>
          <button type="button" onClick={hunks.undo}>
            Undo
          </button>
        </div>
      )}
      {read && (
        <DiffFiles read={read} closed={closed} onToggle={toggle} review={review} hunks={hunks} />
      )}
      <ReviewBar
        paneId={paneId}
        lines={lines}
        checkout={read?.name ?? lines[0] ?? ''}
        scope={scope}
        comments={review.list}
        onSent={review.sent}
        onRestore={review.restore}
      />
    </div>
  );
}
