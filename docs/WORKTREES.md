# Git worktrees

A linked git worktree is a second checkout of a repository, on its own branch. Agents work in them so that several can change one repository at once. tmuxy shows each pane's branch in the tree ([TMUX-CONFIG.md](TMUX-CONFIG.md)), and removes a worktree without losing the work in it.

## Making one for a task

`tmuxy worktree new [--branch B] [--from REF] [--agent CMD] [--no-tab] [-- task]`

1. The branch is `--branch`, else the task in a few words (`Fix the login redirect` is `fix-the-login-redirect`, at most 40 characters).
2. The worktree goes beside the repository's main one: `<main>-<last part of the branch>`, so `~/src/app` gets `~/src/app-fix-the-login-redirect`. An existing directory or branch is refused.
3. A tab opens in it, named after the branch, beside the pane that asked.
4. With `--agent`, the tab runs the agent with the task as its last argument, quoted as one word, then a shell, so the tab outlives the agent. Without it, the tab is a shell. A task with no agent is refused.

The checkout runs no hook and no filter (see below), so a repository that needs them, Git LFS or a post-checkout step, gets the files without them.

## Removing one

`tmuxy worktree remove [path] [--force]` removes the linked worktree `path` is in (default: the current directory).

| It has | Without `--force` | With `--force` |
| --- | --- | --- |
| nothing unsaved | removed | removed |
| uncommitted changes to tracked files | refused | removed, and said |
| untracked files git does not ignore | refused | removed, and said |
| commits that no remote-tracking branch has | refused | removed, and said |

- **The branch is never deleted.** A removed worktree's commits stay on its branch, pushed or not, so `--force` loses uncommitted files at most.
- **Ignored files go with it**: a `build/` the repository ignores is not work.
- **Never removed**: the repository's main worktree, a locked worktree (`git worktree lock`), a directory outside git.
- **"On no remote"** counts the commits reachable from `HEAD` that no `refs/remotes/*` branch has (`git rev-list HEAD --not --remotes`). A branch with no upstream counts too, and a repository with no remote at all has every commit unsaved.
- The refusal, and the `--json` answer, say what was there: `{"ok":true,"path":…,"branch":"feature","lost":{"changed":false,"untracked":false,"unpushed":1}}`.

## git in someone else's repository

The worktree is not tmuxy's, and its repository's config can name programs. Every git call here (`tmuxy-core/src/worktrees/guard.rs`, `create.rs`) runs with:

- no filesystem monitor (`core.fsmonitor=false`) and no hooks (`core.hooksPath=/dev/null`);
- no external diff or textconv, no pager, no credential helper;
- no attributes at all (`GIT_ATTR_SOURCE` and `attr.tree` set to the empty tree), so no clean or smudge filter runs while a changed file is compared;
- no optional locks, so a user's own `git commit` at that moment does not hit `index.lock`; no prompt; stdin closed;
- a 10 s limit per call, after which the answer is "cannot say" and nothing is removed.

The writes are `git worktree add`, run in the main worktree, and `git worktree remove`, run from the shared git directory, never from inside the worktree. Line endings follow git's defaults, since `.gitattributes` is not read: a repository that converts them may read as changed.

## Not yet

- Closing a worktree's tab does not ask. It will, once closing a tab can ask at all (a separate change).
- The tree does not group a repository's worktrees yet: each tab shows its branch, as any pane's does.
- `tmuxy worktree remove` does not look for panes still standing in the worktree: their shells are left in a directory that is gone.

## Tests

`tmuxy-core/src/worktrees/create_tests.rs` makes worktrees in throwaway repositories (the branch from a task, the place beside the main one, refusals, no hook or filter on checkout), and `tests/24-worktrees.test.js` types `tmuxy worktree new` in a browser against a real tmux, with a script standing in for the agent.


`tmuxy-core/src/worktrees/guard_tests.rs` builds throwaway repositories in the temp dir, each with a bare origin: a clean one removed with its branch kept, each kind of unsaved work refused, `--force` saying what it lost, the main and a locked worktree refused, and a repository whose fsmonitor, external diff, clean filter, pager and hooks all name a script that leaves a mark: the mark never appears. A test build refuses to remove a worktree outside the temp dir.
