//! `tmuxy-pty <file> <argv0> [args...]`: run `file` with that argv as a CheerpX
//! pane's program. tmux (patched, see packages/tmuxy-ui/cheerpx/patches)
//! starts this with stdin and stdout on the pane's socket; the program gets a
//! pipe to read and one to write (CheerpX's `shutdown(SHUT_WR)` breaks a
//! socket pair), and everything between the two goes through the line
//! discipline in the library.
//!
//! The program runs with `preload.c` LD_PRELOAD'ed. Ctrl+C needs every
//! process in the pane, and CheerpX has neither process groups nor parent
//! pids in /proc, so each process records its pid in a directory of this
//! pane's. Ctrl+D is an EOT byte on the input pipe, which the preload turns
//! into one end of file for whoever reads it: the pipe itself stays open,
//! since every program the shell runs reads it after the one that got EOF.

use std::ffi::{CString, OsString};
use std::os::unix::ffi::OsStringExt;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use tmuxy_pty::{translate_output, Action, LineDiscipline};

const PRELOAD: &str = "/usr/lib/tmuxy-pty.so";
const PID_ROOT: &str = "/tmp/tmuxy-pty";
const PANE: i32 = 0;
const PANE_OUT: i32 = 1;
/// What Ctrl+D puts on the program's input (see `preload.c`).
const EOT: u8 = 0x04;
/// Home the cursor and erase the screen.
const CLEAR: &[u8] = b"\x1b[H\x1b[2J";
/// How long the shell's output must pause before a cleared screen shows the
/// line being typed again: its new prompt can arrive in several writes.
const REDRAW_QUIET: Duration = Duration::from_millis(50);

/// The line Ctrl+L owes the screen, and when to show it.
#[derive(Default)]
struct Redraw {
    line: Option<Vec<u8>>,
    due: Option<Instant>,
}

fn main() {
    let args: Vec<CString> = std::env::args_os()
        .skip(1)
        .filter_map(|arg: OsString| CString::new(arg.into_vec()).ok())
        .collect();
    if args.len() < 2 {
        eprintln!("usage: tmuxy-pty <file> <argv0> [args...]");
        std::process::exit(2);
    }
    let pids = Path::new(PID_ROOT).join(std::process::id().to_string());
    let _ = std::fs::remove_dir_all(&pids);
    if let Err(e) = std::fs::create_dir_all(&pids) {
        eprintln!("tmuxy-pty: {}: {e}", pids.display());
        std::process::exit(1);
    }
    std::env::set_var("TMUXY_PTY_PIDS", &pids);
    let preload = match std::env::var("LD_PRELOAD") {
        Ok(other) if !other.is_empty() => format!("{PRELOAD}:{other}"),
        _ => PRELOAD.to_string(),
    };
    std::env::set_var("LD_PRELOAD", preload);

    let pane = match spawn(&args[0], &args[1..], pids) {
        Ok(pane) => pane,
        Err(e) => {
            eprintln!("tmuxy-pty: {e}");
            std::process::exit(1);
        }
    };
    std::process::exit(pane.run());
}

fn pipe() -> std::io::Result<[i32; 2]> {
    let mut fds = [0; 2];
    // SAFETY: pipe writes two fds into a two-element array.
    if unsafe { libc::pipe(fds.as_mut_ptr()) } != 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(fds)
}

/// Fork `file` with `argv`, reading one pipe and writing (stdout and stderr)
/// another.
fn spawn(file: &CString, argv: &[CString], pids: PathBuf) -> std::io::Result<Pane> {
    let [stdin_read, stdin_write] = pipe()?;
    let [output_read, output_write] = pipe()?;
    // The preload reads an EOT as end of file only on this pipe, not on a
    // file or another pipe a program reads as its stdin.
    // SAFETY: fstat fills a stat struct for an fd this process owns.
    let mut st: libc::stat = unsafe { std::mem::zeroed() };
    if unsafe { libc::fstat(stdin_read, &mut st) } == 0 {
        std::env::set_var("TMUXY_PTY_INPUT", st.st_ino.to_string());
    }
    let mut ptrs: Vec<*const libc::c_char> = argv.iter().map(|a| a.as_ptr()).collect();
    ptrs.push(std::ptr::null());
    // SAFETY: the child only calls async-signal-safe functions before exec.
    match unsafe { libc::fork() } {
        -1 => Err(std::io::Error::last_os_error()),
        0 => unsafe {
            libc::dup2(stdin_read, 0);
            libc::dup2(output_write, 1);
            libc::dup2(output_write, 2);
            for fd in [stdin_read, stdin_write, output_read, output_write] {
                if fd > 2 {
                    libc::close(fd);
                }
            }
            libc::signal(libc::SIGPIPE, libc::SIG_DFL);
            libc::execvp(file.as_ptr(), ptrs.as_ptr());
            libc::_exit(127)
        },
        child => {
            // SAFETY: closing the child's ends, which this process no longer uses.
            unsafe {
                libc::close(stdin_read);
                libc::close(output_write);
            }
            Ok(Pane {
                child,
                input: stdin_write,
                output: output_read,
                pids,
            })
        }
    }
}

struct Pane {
    child: i32,
    /// What the program reads.
    input: i32,
    /// What the program writes, stdout and stderr both.
    output: i32,
    pids: PathBuf,
}

impl Pane {
    /// Relay until the program exits or tmux closes the pane; returns the
    /// exit code to leave with.
    fn run(&self) -> i32 {
        // SAFETY: ignoring SIGPIPE so a closed peer shows up as EPIPE.
        unsafe { libc::signal(libc::SIGPIPE, libc::SIG_IGN) };
        let mut ld = LineDiscipline::new();
        let mut buf = [0u8; 4096];
        let mut output_open = true;
        let mut redraw = Redraw::default();
        loop {
            if let Some(code) = self.exited() {
                self.drain(&mut buf);
                self.signal_all(libc::SIGHUP);
                return code;
            }
            if redraw.due.is_some_and(|due| Instant::now() >= due) {
                if let Some(line) = redraw.line.take() {
                    write_all(PANE_OUT, &line);
                }
                redraw.due = None;
            }
            let mut fds = [
                libc::pollfd {
                    fd: PANE,
                    events: libc::POLLIN,
                    revents: 0,
                },
                libc::pollfd {
                    fd: if output_open { self.output } else { -1 },
                    events: libc::POLLIN,
                    revents: 0,
                },
            ];
            let timeout = if redraw.due.is_some() { 20 } else { 200 };
            // SAFETY: poll reads and writes the two pollfds it is given.
            if unsafe { libc::poll(fds.as_mut_ptr(), 2, timeout) } <= 0 {
                continue;
            }
            if fds[0].revents != 0 {
                let Some(n) = read(PANE, &mut buf) else {
                    self.signal_all(libc::SIGHUP);
                    return 0;
                };
                for action in ld.input(&buf[..n]) {
                    let ok = match action {
                        Action::ClearScreen => self.clear_screen(ld.line(), &mut redraw),
                        other => self.apply(other),
                    };
                    if !ok {
                        self.signal_all(libc::SIGHUP);
                        return 0;
                    }
                }
            }
            if fds[1].revents != 0 {
                match read(self.output, &mut buf) {
                    Some(n) => {
                        if !write_all(PANE_OUT, &translate_output(&buf[..n])) {
                            self.signal_all(libc::SIGHUP);
                            return 0;
                        }
                        if redraw.line.is_some() {
                            redraw.due = Some(Instant::now() + REDRAW_QUIET);
                        }
                    }
                    None => output_open = false,
                }
            }
        }
    }

    /// Carry out one keystroke's action; false once the pane is gone.
    fn apply(&self, action: Action) -> bool {
        match action {
            Action::Echo(bytes) => return write_all(PANE_OUT, &bytes),
            Action::Send(bytes) => {
                write_all(self.input, &bytes);
            }
            Action::Interrupt => self.signal_all(libc::SIGINT),
            Action::Quit => self.signal_all(libc::SIGQUIT),
            Action::EndOfInput => {
                write_all(self.input, &[EOT]);
            }
            Action::ClearScreen => {}
        }
        true
    }

    /// Ctrl+L, as readline does it at a prompt: clear the screen, have the
    /// shell print its prompt again (an empty line does that), and show the
    /// line being typed after it once the shell has gone quiet. While a
    /// command runs the empty line would be its input, so then nothing
    /// happens. False once the pane is gone.
    fn clear_screen(&self, line: &[u8], redraw: &mut Redraw) -> bool {
        if !self.shell_idle() {
            return true;
        }
        redraw.line = Some(line.to_vec());
        redraw.due = None;
        let shown = write_all(PANE_OUT, CLEAR);
        write_all(self.input, b"\n");
        shown
    }

    /// Whether the shell is alone in the pane: no other recorded process lives.
    fn shell_idle(&self) -> bool {
        let Ok(entries) = std::fs::read_dir(&self.pids) else {
            return true;
        };
        !entries.flatten().any(|entry| {
            entry
                .file_name()
                .to_str()
                .and_then(|s| s.parse::<i32>().ok())
                // SAFETY: kill with signal 0 only checks that the pid exists.
                .is_some_and(|pid| pid != self.child && unsafe { libc::kill(pid, 0) } == 0)
        })
    }

    /// The program's exit code once it has exited (128 + signal if killed).
    fn exited(&self) -> Option<i32> {
        let mut status = 0;
        // SAFETY: waitpid on our own child, without blocking.
        if unsafe { libc::waitpid(self.child, &mut status, libc::WNOHANG) } != self.child {
            return None;
        }
        Some(if libc::WIFSIGNALED(status) {
            128 + libc::WTERMSIG(status)
        } else {
            libc::WEXITSTATUS(status)
        })
    }

    /// Pass on what the program wrote before it exited, for a short while: a
    /// background process may still hold its output open.
    fn drain(&self, buf: &mut [u8]) {
        let until = Instant::now() + Duration::from_millis(200);
        while Instant::now() < until {
            let mut fd = libc::pollfd {
                fd: self.output,
                events: libc::POLLIN,
                revents: 0,
            };
            // SAFETY: poll on one pollfd.
            if unsafe { libc::poll(&mut fd, 1, 50) } <= 0 {
                return;
            }
            match read(self.output, buf) {
                Some(n) => {
                    write_all(PANE_OUT, &translate_output(&buf[..n]));
                }
                None => return,
            }
        }
    }

    /// Send `sig` to every process recorded for this pane, forgetting those
    /// that are gone, then to the program. An interrupted process is marked
    /// with a `<pid>.int` file first: CheerpX reports a death by SIGINT as one
    /// by SIGKILL, and the preload turns it back for whoever waits on it, so
    /// bash abandons the rest of the line as it does for a terminal's Ctrl+C.
    fn signal_all(&self, sig: i32) {
        if let Ok(entries) = std::fs::read_dir(&self.pids) {
            for entry in entries.flatten() {
                let Some(pid) = entry
                    .file_name()
                    .to_str()
                    .and_then(|s| s.parse::<i32>().ok())
                else {
                    continue;
                };
                if pid == self.child {
                    continue;
                }
                let marker = self.pids.join(format!("{pid}.int"));
                if sig == libc::SIGINT {
                    let _ = std::fs::File::create(&marker);
                }
                // SAFETY: kill only sends a signal.
                if unsafe { libc::kill(pid, sig) } == -1 {
                    let _ = std::fs::remove_file(entry.path());
                    let _ = std::fs::remove_file(marker);
                }
            }
        }
        // SAFETY: kill only sends a signal.
        unsafe { libc::kill(self.child, sig) };
        if sig == libc::SIGHUP {
            let _ = std::fs::remove_dir_all(&self.pids);
        }
    }
}

/// One read; None on end of file or an error other than an interruption.
fn read(fd: i32, buf: &mut [u8]) -> Option<usize> {
    loop {
        // SAFETY: read into a buffer of the length given.
        let n = unsafe { libc::read(fd, buf.as_mut_ptr().cast(), buf.len()) };
        if n > 0 {
            return Some(n as usize);
        }
        if n == 0 || std::io::Error::last_os_error().kind() != std::io::ErrorKind::Interrupted {
            return None;
        }
    }
}

/// Write all of `bytes`; false if the peer is gone.
fn write_all(fd: i32, mut bytes: &[u8]) -> bool {
    while !bytes.is_empty() {
        // SAFETY: write from a buffer of the length given.
        let n = unsafe { libc::write(fd, bytes.as_ptr().cast(), bytes.len()) };
        if n < 0 {
            if std::io::Error::last_os_error().kind() == std::io::ErrorKind::Interrupted {
                continue;
            }
            return false;
        }
        bytes = &bytes[n as usize..];
    }
    true
}
