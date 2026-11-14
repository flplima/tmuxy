/**
 * A `diff` widget's read: the changes of one git checkout in one scope, the
 * wire shape of `tmuxy-core/src/diff_review.rs`. File names and lines are
 * anyone's text (the checkout may be a stranger's), drawn as text only.
 */

import { Schema } from 'effect';

const optional = <A, I>(schema: Schema.Schema<A, I>) => Schema.optional(Schema.NullOr(schema));

/**
 * unstaged: the working tree against the index; staged: the index against
 * HEAD; branch: the working tree against the branch's base; turn: what an
 * agent beside the diff changed in its last turn.
 */
export const DiffScope = Schema.Literal('unstaged', 'staged', 'branch', 'turn');
export type DiffScope = Schema.Schema.Type<typeof DiffScope>;

export const DIFF_SCOPES: readonly DiffScope[] = ['unstaged', 'staged', 'branch', 'turn'];

export const DiffLine = Schema.Struct({
  kind: Schema.Literal('context', 'added', 'removed', 'note'),
  /** Its number in the old file, when it is in it. */
  old: optional(Schema.Number),
  /** Its number in the new file, when it is in it. */
  new: optional(Schema.Number),
  text: Schema.String,
});
export type DiffLine = Schema.Schema.Type<typeof DiffLine>;

export const DiffHunk = Schema.Struct({
  header: Schema.String,
  lines: Schema.Array(DiffLine),
});
export type DiffHunk = Schema.Schema.Type<typeof DiffHunk>;

export const DiffFile = Schema.Struct({
  path: Schema.String,
  oldPath: optional(Schema.String),
  status: Schema.Literal('modified', 'added', 'deleted', 'renamed'),
  binary: Schema.Boolean,
  modeChange: optional(Schema.String),
  /** Names the file's patch as read: a hunk action hands it back (`change_hunk`). */
  token: Schema.String,
  hunks: Schema.Array(DiffHunk),
});
export type DiffFile = Schema.Schema.Type<typeof DiffFile>;

export const DiffRead = Schema.Struct({
  name: Schema.String,
  scope: DiffScope,
  branch: optional(Schema.String),
  base: optional(Schema.String),
  files: Schema.Array(DiffFile),
  untracked: Schema.Array(Schema.String),
  untrackedMore: Schema.Number,
  truncated: Schema.Boolean,
  /** The turn scope's turn: the agent's pane, and whether it is still at it. */
  turn: optional(
    Schema.Struct({
      agent: Schema.String,
      ongoing: Schema.Boolean,
      /** Untracked files the turn did not copy (too large, or named like a secret), with why. */
      leftOut: Schema.Array(Schema.String),
    }),
  ),
});
export type DiffRead = Schema.Schema.Type<typeof DiffRead>;

/** Lines added and removed in `file`. */
export function fileCounts(file: DiffFile): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (line.kind === 'added') added++;
      else if (line.kind === 'removed') removed++;
    }
  }
  return { added, removed };
}

/** What a hunk's button asks of the server (`change_hunk`). */
export const HunkAction = Schema.Literal('stage', 'unstage', 'revert');
export type HunkAction = Schema.Schema.Type<typeof HunkAction>;

/** The actions a hunk of `file` offers in `scope`: a changed text file's only. */
export function hunkActions(scope: DiffScope, file: DiffFile): HunkAction[] {
  if (file.status !== 'modified' || file.binary || file.modeChange) return [];
  if (scope === 'unstaged') return ['stage', 'revert'];
  if (scope === 'staged') return ['unstage'];
  return [];
}

/** The sign git puts before a line of each kind. */
export const LINE_SIGN: Record<DiffLine['kind'], string> = {
  context: ' ',
  added: '+',
  removed: '-',
  note: '\\',
};
