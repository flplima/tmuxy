# CheerpX guest

An experiment in replacing the v86 guest with CheerpX, Leaning Technologies'
x86-to-WebAssembly JIT. CheerpX runs ordinary 32-bit Linux binaries from an
ext2 image streamed over HTTP, with no kernel to boot and no snapshot to
download. A bash loop runs about ten times faster than in the v86 guest.

**Status:** the demo site runs on it where the page is cross-origin isolated
(`CheerpXTmuxAdapter`, in `src/infra/transport/drivers/cheerpx/`); the smoke
page drives the bare control-mode stream.

## Layout

| Path                            | What it is                                                                                                         |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `Dockerfile`                    | The guest: Alpine i386, bash, tmux built from source with `patches/` applied, the tmuxy-pty preload, tmuxy scripts |
| `patches/`                      | Changes tmux needs under CheerpX, applied in name order                                                            |
| `pack.sh`                       | Packs the exported root filesystem as the ext2 image CheerpX mounts                                                |
| `rootfs/`                       | Files copied into the guest as they are, such as the console relay `tmuxy-console`                                 |
| `smoke/`                        | A page that boots the image and exposes its console to a test driver                                               |
| `/packages/tmuxy-pty/`          | The terminal each pane runs on (`/usr/bin/tmuxy-pty`), with its unit and socket-pair tests                         |
| `/packages/tmuxy-pty/preload.c` | LD_PRELOAD'ed into every pane program (`/usr/lib/tmuxy-pty.so`)                                                    |

In the Path column, a leading `/` is the repo root.

The build is `npm run build:cheerpx-image -w tmuxy-ui`, which writes
`cheerpx-assets/tmuxy.ext2`. It needs Docker with linux/386 emulation and the
`i686-unknown-linux-musl` Rust target (`CARGO` names the cargo that has it).
`npm run smoke:cheerpx -w tmuxy-ui` serves the page on port 9020 with the
cross-origin isolation headers CheerpX requires. Add `?control` to run the
control-mode relay instead of a shell.

## How a pane runs

CheerpX gives every process the same pseudo-terminal, so a pane cannot have
one. `patches/pane-socketpair.patch` makes tmux start each pane on a socket
pair, under `tmuxy-pty`, which plays the terminal:

```
tmux (pane fd) ── socket pair ── tmuxy-pty ── two pipes ── bash, and what it runs
                                 echo, line editing,         LD_PRELOAD tmuxy-pty.so
                                 history, Ctrl+C/D,          records each pid; answers
                                 LF to CR LF                 as a terminal for job control
```

Ctrl+C reaches every process in the pane through the pids the preload
records, since CheerpX can neither signal a process group nor report parent
pids. The pane's bash runs with `--noediting -i`, so line editing is the
helper's.

## What CheerpX does differently

| Behaviour                                                                    | Consequence                                                                                  | Handled by                                                                                                   |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Descriptors sent over a Unix socket arrive as -1                             | A `tmux` client writing into a pipe never sees EOF, and a control client gets no output      | `patches/client-identify-fds.patch`, `patches/control-fifos.patch` with `rootfs/usr/local/bin/tmuxy-console` |
| A server forked by its first client never answers that client                | `tmux new-session -d` with no server running fails                                           | The relay starts the server with `tmux -D` in the background                                                 |
| `/dev/pts` exists only as a mount                                            | Without it `openpty` fails                                                                   | The smoke page mounts `devpts`                                                                               |
| The image server must send `Last-Modified` or `ETag`                         | The disk device refuses to open                                                              | `scripts/serve-cheerpx-smoke.mjs`                                                                            |
| Every pty is number 1, and `/dev/pts/1` reaches the oldest open pty          | Every pane after the first would share the first pane's terminal                             | `patches/pane-socketpair.patch` and `tmuxy-pty`                                                              |
| No process-group signals (`kill(-pgid)` is ESRCH), no parent pids in `/proc` | Ctrl+C and `kill %1` reach nothing                                                           | The preload records pids, and its `killpg()` signals the recorded ones in the group                          |
| A death by SIGINT is reported as one by SIGKILL                              | bash carries on with the rest of a line after Ctrl+C                                         | The preload's `waitpid()` reports SIGINT for a pid the helper interrupted                                    |
| `/dev/tty` opens the console even with no controlling terminal               | bash takes the console, which carries the control-mode stream, as its terminal               | The preload's `open()` refuses `/dev/tty`                                                                    |
| `getpgid()` of a pid that is gone hangs the machine                          | Any lookup of a stale pid freezes the guest                                                  | The preload checks `kill(pid, 0)` first                                                                      |
| `shutdown(SHUT_WR)` on a socket pair breaks the other direction              | A job tmux waits for (`run-shell`, `if-shell`) never ends, and stalls the control client     | `patches/job-no-half-close.patch`; `tmuxy-pty` gives programs pipes                                          |
| Opening a fifo to write does not wait for a reader                           | The relay's input before the attach fails (EPIPE) and ends it                                | The relay forwards input once the control client is attached                                                 |
| `hostname` cannot be set                                                     | The prompt's `\h` is empty                                                                   | The guest's `.bashrc` names the host                                                                         |
| `/proc/<pid>` has no `cwd`                                                   | tmux cannot tell a pane's directory: tab names come out empty, and an empty tab is not drawn | `patches/pane-path-from-osc7.patch`; the guest's prompt reports its directory with OSC 7                     |

## Limits

A pane is not a terminal to the programs in it: `tty` says so, `ls` prints
one name per line, and full-screen programs (vim, less) do not work. Panes do
not learn their size. Ctrl+Z does nothing. A job ended by any signal is
reported as `Killed`.
