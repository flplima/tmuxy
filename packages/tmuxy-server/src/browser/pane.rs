//! The browser as a terminal program.
//!
//! This is the whole design, and it is worth stating plainly because the
//! previous one was the opposite: tmuxy is a terminal, so a browser inside it
//! should be a terminal PROGRAM — one that draws with escape sequences and
//! reads the pty. Nothing else is needed. No HTTP route, no widget, no custom
//! URI scheme, no IPC. The same program works on the web UI and in the desktop
//! app because both already render inline images and already forward mouse
//! reports, and neither has to learn anything new.
//!
//! The same shape every terminal browser converges on: casty (Chrome → Kitty
//! graphics), browsh (headless Firefox → half-blocks), carboxyl (Servo → TTY).
//!
//! ## Output: one picture, redrawn in place
//!
//! Each frame goes out as an iTerm2 inline image (`OSC 1337`) anchored at the
//! home position. tmuxy's image parser replaces the placement already at that
//! anchor rather than stacking a new one (`control_mode/images.rs`), which is
//! exactly the live-preview behaviour this needs — one picture on screen, swapped
//! with no gap in between.
//!
//! ## Input: the pane's own mouse reporting
//!
//! Enabling SGR mouse tracking makes tmuxy forward clicks, drags and wheels to
//! this program as `\e[<b;x;yM` reports, through the path it already uses for
//! any mouse-tracking application. Coordinates arrive in CELLS — that is the
//! resolution tmux reports and the ceiling on how precisely a click can land.
//!
//! ## Why there is a status row
//!
//! The bottom line is left out of the picture and used for verb output, so an
//! agent driving the pane with `tmuxy pane send` can read the answer back with
//! `tmuxy pane capture`. That is the entire agent protocol; it needs no API.

use std::io::{Read, Write};
use std::os::fd::AsRawFd;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use chromiumoxide::cdp::browser_protocol::input::{
    DispatchKeyEventParams, DispatchKeyEventType, DispatchMouseEventParams, DispatchMouseEventType,
    MouseButton,
};

use super::session::{Attachment, Output, Session};
use super::verbs;

/// Cell size in pixels when the terminal does not report one.
///
/// tmux usually reports `ws_xpixel`/`ws_ypixel` as zero — it has no idea what
/// the font is, and in tmuxy's case the "terminal" is a browser whose cell size
/// is whatever the user's font settings produce. These are a reasonable
/// mid-range cell; being wrong only changes how much page fits in the pane, not
/// whether it works, and `TMUXY_CELL_PX` overrides it for anyone who cares.
const DEFAULT_CELL_W: u16 = 8;
const DEFAULT_CELL_H: u16 = 17;

/// How often to redraw a page that has not changed.
///
/// Not a frame rate — a page that is not changing produces no frames at all, and
/// this is not trying to produce any. It exists because a tmuxy client that
/// attaches LATER never saw the escape that placed the current picture: tmux
/// strips image escapes from scrollback, so `capture-pane` cannot replay them.
/// Without this, opening a second tab onto a session shows an empty pane until
/// the page happens to move. The cost is one JPEG every few seconds for a pane
/// somebody is looking at.
const REDRAW_INTERVAL: std::time::Duration = std::time::Duration::from_secs(3);

/// Terminal control sequences, named so the call sites read as intent.
mod term {
    pub const ALT_SCREEN_ON: &str = "\x1b[?1049h";
    pub const ALT_SCREEN_OFF: &str = "\x1b[?1049l";
    /// Button-event tracking (press, release, drag) plus SGR coordinates. 1002
    /// rather than 1003: motion with no button down would be a report per cell
    /// crossed, which is a lot of traffic for hover alone.
    pub const MOUSE_ON: &str = "\x1b[?1002h\x1b[?1006h";
    pub const MOUSE_OFF: &str = "\x1b[?1006l\x1b[?1002l";
    pub const HIDE_CURSOR: &str = "\x1b[?25l";
    pub const SHOW_CURSOR: &str = "\x1b[?25h";
    pub const HOME: &str = "\x1b[H";
    pub const CLEAR: &str = "\x1b[2J";
}

/// The pane's size, in cells and in the pixels a page should lay out against.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PaneSize {
    pub cols: u16,
    pub rows: u16,
    pub cell_w: u16,
    pub cell_h: u16,
}

impl PaneSize {
    /// The rows the picture occupies: everything but the status row.
    pub fn image_rows(&self) -> u16 {
        self.rows.saturating_sub(1).max(1)
    }

    /// The viewport the page should lay out in.
    pub fn viewport(&self) -> (u32, u32) {
        (
            u32::from(self.cols) * u32::from(self.cell_w),
            u32::from(self.image_rows()) * u32::from(self.cell_h),
        )
    }
}

/// Read the pane's size from the terminal, falling back to a usable default.
///
/// `TIOCGWINSZ` is the only thing that knows, and its pixel fields are usually
/// zero under tmux — hence the fallback and the override.
pub fn pane_size() -> PaneSize {
    let mut ws: libc::winsize = unsafe { std::mem::zeroed() };
    // SAFETY: `ws` is a winsize, which is what TIOCGWINSZ writes.
    let ok = unsafe { libc::ioctl(std::io::stdout().as_raw_fd(), libc::TIOCGWINSZ, &mut ws) } == 0;

    let (cols, rows) = if ok && ws.ws_col > 0 && ws.ws_row > 0 {
        (ws.ws_col, ws.ws_row)
    } else {
        (80, 24)
    };

    let (mut cell_w, mut cell_h) = (DEFAULT_CELL_W, DEFAULT_CELL_H);
    if ok && ws.ws_xpixel > 0 && ws.ws_ypixel > 0 && cols > 0 && rows > 0 {
        cell_w = (ws.ws_xpixel / cols).max(1);
        cell_h = (ws.ws_ypixel / rows).max(1);
    }
    if let Some((w, h)) = std::env::var("TMUXY_CELL_PX")
        .ok()
        .and_then(|v| parse_cell_px(&v))
    {
        cell_w = w;
        cell_h = h;
    }

    PaneSize {
        cols,
        rows,
        cell_w,
        cell_h,
    }
}

/// `WxH`, as `TMUXY_CELL_PX` spells it.
fn parse_cell_px(raw: &str) -> Option<(u16, u16)> {
    let (w, h) = raw.split_once(['x', 'X'])?;
    Some((w.trim().parse().ok()?, h.trim().parse().ok()?))
}

/// One frame as the escape sequence that draws it.
///
/// iTerm2's inline-image protocol rather than Kitty's: it is one self-contained
/// escape with the payload inline, where Kitty's wants chunking above 4KB and a
/// placement command of its own. tmuxy decodes both; this one is less to get
/// wrong per frame.
///
/// The cursor goes home first. That is what makes the redraw REPLACE rather than
/// accumulate: tmuxy anchors a placement at the cursor and swaps whatever was
/// already anchored there.
pub fn draw_frame(frame: &[u8], size: PaneSize) -> Vec<u8> {
    use base64::Engine as _;
    let encoded = base64::engine::general_purpose::STANDARD.encode(frame);
    format!(
        "{}\x1b]1337;File=inline=1;width={};height={}:{}\x07",
        term::HOME,
        size.cols,
        size.image_rows(),
        encoded
    )
    .into_bytes()
}

/// Put the terminal in raw mode for as long as this lives.
///
/// Raw because every key belongs to the page: line discipline would hold input
/// until Enter, echo it over the picture, and swallow ctrl+c instead of letting
/// the program decide what it means.
struct RawMode {
    fd: i32,
    original: libc::termios,
}

impl RawMode {
    fn enter() -> std::io::Result<Self> {
        let fd = std::io::stdin().as_raw_fd();
        let mut original: libc::termios = unsafe { std::mem::zeroed() };
        // SAFETY: `original` is a termios; `fd` is this process's stdin.
        if unsafe { libc::tcgetattr(fd, &mut original) } != 0 {
            return Err(std::io::Error::last_os_error());
        }
        let mut raw = original;
        // SAFETY: `raw` is a termios initialised by tcgetattr above.
        unsafe { libc::cfmakeraw(&mut raw) };
        // Read returns as soon as a byte is there, rather than waiting for a
        // full buffer: a keystroke should reach the page when it is typed.
        raw.c_cc[libc::VMIN] = 1;
        raw.c_cc[libc::VTIME] = 0;
        // SAFETY: same.
        if unsafe { libc::tcsetattr(fd, libc::TCSANOW, &raw) } != 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(Self { fd, original })
    }
}

impl Drop for RawMode {
    fn drop(&mut self) {
        // SAFETY: restoring the termios this type captured on the way in.
        unsafe { libc::tcsetattr(self.fd, libc::TCSANOW, &self.original) };
    }
}

/// What a byte from the terminal meant.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Input {
    /// An SGR mouse report: `\e[<button;col;row(M|m)`, 1-indexed cells.
    Mouse {
        button: u16,
        col: u16,
        row: u16,
        pressed: bool,
    },
    /// A key, as the bytes it arrived as.
    Key(Vec<u8>),
}

/// Pull whole inputs off a byte buffer, leaving any partial tail behind.
///
/// Terminal input arrives in whatever sizes the kernel hands over, and an
/// escape sequence can straddle two reads. Anything incomplete stays in the
/// buffer for the next one — the same rule the control-mode parser follows, and
/// for the same reason: half a mouse report read as keys types garbage into the
/// page.
pub fn take_inputs(buffer: &mut Vec<u8>) -> Vec<Input> {
    let mut out = Vec::new();
    loop {
        if buffer.is_empty() {
            return out;
        }
        // An SGR mouse report starts `\e[<`.
        if buffer.starts_with(b"\x1b[<") {
            let Some(end) = buffer.iter().position(|b| *b == b'M' || *b == b'm') else {
                // The rest has not arrived; an unterminated report is not keys.
                return out;
            };
            let pressed = buffer[end] == b'M';
            let body = String::from_utf8_lossy(&buffer[3..end]).to_string();
            let parts: Vec<&str> = body.split(';').collect();
            if parts.len() == 3 {
                if let (Ok(button), Ok(col), Ok(row)) = (
                    parts[0].parse::<u16>(),
                    parts[1].parse::<u16>(),
                    parts[2].parse::<u16>(),
                ) {
                    out.push(Input::Mouse {
                        button,
                        col,
                        row,
                        pressed,
                    });
                }
            }
            buffer.drain(..=end);
            continue;
        }
        // A lone ESC may be the start of a sequence whose rest is still coming.
        // Holding it back costs one keystroke of latency on a bare Escape and
        // avoids splitting every arrow key into two bogus inputs.
        if buffer == b"\x1b" {
            return out;
        }
        // Any other escape sequence: take it up to its final byte so it reaches
        // the page as one key rather than as `[`, `A`.
        if buffer.starts_with(b"\x1b[") {
            if let Some(end) = buffer[2..].iter().position(|b| b.is_ascii_alphabetic()) {
                let seq = buffer.drain(..=(end + 2)).collect();
                out.push(Input::Key(seq));
                continue;
            }
            return out;
        }
        // A plain byte, or the start of a UTF-8 sequence.
        let take = utf8_len(buffer[0]);
        if buffer.len() < take {
            return out;
        }
        let key: Vec<u8> = buffer.drain(..take).collect();
        out.push(Input::Key(key));
    }
}

/// How many bytes this UTF-8 lead byte begins.
fn utf8_len(lead: u8) -> usize {
    match lead {
        0x00..=0x7f => 1,
        0xc0..=0xdf => 2,
        0xe0..=0xef => 3,
        0xf0..=0xf7 => 4,
        // A continuation byte on its own is not a character; take it alone
        // rather than waiting forever for a lead that is not coming.
        _ => 1,
    }
}

/// Where a cell lands on the page, in CSS pixels.
///
/// The centre of the cell, not its corner: a click aimed at a link should land
/// in the middle of the cell the user pointed at. Cells are the resolution tmux
/// reports — this is the ceiling on how precisely a click can land, and why
/// `:click <selector>` exists for anything smaller than a cell.
pub fn cell_to_page(col: u16, row: u16, size: PaneSize) -> (f64, f64) {
    let x = (f64::from(col.saturating_sub(1)) + 0.5) * f64::from(size.cell_w);
    let y = (f64::from(row.saturating_sub(1)) + 0.5) * f64::from(size.cell_h);
    (x, y)
}

/// An SGR button code as what it means to a page.
///
/// The low two bits are the button, bit 5 (32) marks motion, and 64 marks a
/// wheel event where the low bits become the direction.
pub fn decode_button(code: u16) -> ButtonMeaning {
    if code & 64 != 0 {
        return match code & 3 {
            0 => ButtonMeaning::Wheel { up: true },
            1 => ButtonMeaning::Wheel { up: false },
            _ => ButtonMeaning::Ignored,
        };
    }
    let dragging = code & 32 != 0;
    let button = match code & 3 {
        0 => MouseButton::Left,
        1 => MouseButton::Middle,
        2 => MouseButton::Right,
        // 3 with no motion bit is "all buttons released".
        _ => return ButtonMeaning::Release,
    };
    ButtonMeaning::Button { button, dragging }
}

/// What an SGR button code meant.
#[derive(Debug, Clone, PartialEq)]
pub enum ButtonMeaning {
    Button { button: MouseButton, dragging: bool },
    Wheel { up: bool },
    Release,
    Ignored,
}

/// How far one wheel notch scrolls the page.
const WHEEL_STEP: f64 = 120.0;

/// Run a browser pane until the user leaves it.
/// How to bring this pane back, as the `tmuxy` CLI is told it
/// (`tmuxy pane restore-cmd '<line>' <pane>` → `@tmuxy-pane-restore`, see
/// `tmuxy_core::session_snapshot`).
///
/// The CLI, never tmux directly: a mutating tmux command from inside a pane
/// while control mode is attached crashes tmux 3.5a (docs/TMUX.md), and the
/// CLI is the one place that knows to wrap it in `run-shell`.
pub fn restore_tag_args(pane: &str, session: &str, url: Option<&str>) -> Vec<String> {
    let mut line = format!("tmuxy browser --repl --session {}", shell_quote(session));
    if let Some(url) = url {
        line.push_str(" --goto ");
        line.push_str(&shell_quote(url));
    }
    vec!["pane".into(), "restore-cmd".into(), line, pane.into()]
}

/// Single-quote for a shell, as `_lib`'s `shquote` does.
fn shell_quote(word: &str) -> String {
    format!("'{}'", word.replace('\'', r"'\''"))
}

/// Record the page this pane is on, if it is running under tmux at all.
///
/// `TMUXY_CLI` is set by the CLI when it starts this program, so the pane
/// reaches the same `tmuxy` that launched it wherever it is installed; a
/// pane started some other way falls back to `tmuxy` on the PATH.
fn announce_restore(session: &str, url: Option<&str>) {
    let Some(pane) = std::env::var_os("TMUX_PANE") else {
        return;
    };
    let cli = std::env::var_os("TMUXY_CLI").unwrap_or_else(|| "tmuxy".into());
    let _ = std::process::Command::new(cli)
        .args(restore_tag_args(&pane.to_string_lossy(), session, url))
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();
}

/// Where the page is, for the restore tag; `None` on `about:blank` or failure.
async fn current_url(session: &mut Session) -> Option<String> {
    match session.run(verbs::Verb::Url).await {
        Ok(Output::Line(url)) if !url.is_empty() && url != "about:blank" => Some(url),
        _ => None,
    }
}

/// Run a browser pane until the user leaves it.
pub async fn run(
    state_dir: &Path,
    session_name: &str,
    attach: Option<String>,
    goto: Option<String>,
) -> i32 {
    let session = match attach {
        Some(endpoint) => Session::attach(state_dir, session_name, &endpoint).await,
        None => Session::launch(state_dir, session_name).await,
    };

    let mut session = match session {
        Ok(session) => session,
        Err(error) => {
            eprintln!("tmuxy browser: {error}");
            return 1;
        }
    };

    let attached = session.attachment() == Attachment::Attached;
    let size = pane_size();
    let (vw, vh) = size.viewport();
    if let Err(error) = session.set_viewport(vw, vh, 1.0).await {
        eprintln!("tmuxy browser: {error}");
    }

    // The pane's size, as everything that cares reads it. A `watch` rather than
    // a shared cell because the resize has to WAKE the read loop: the viewport
    // only moves when someone asks the engine, and there is nothing else to
    // wake it when the user drags a divider and types nothing.
    let (size_tx, size_rx) = tokio::sync::watch::channel(size);
    let resizes = tokio::spawn(watch_for_resize(size_tx));

    let mut stdout = std::io::stdout();
    // The alternate screen keeps the picture out of the scrollback, so leaving
    // the pane gives the shell back exactly as it was.
    let _ = write!(stdout, "{}{}", term::ALT_SCREEN_ON, term::CLEAR);
    if !attached {
        let _ = write!(stdout, "{}{}", term::MOUSE_ON, term::HIDE_CURSOR);
    }
    let _ = stdout.flush();

    let raw = RawMode::enter().ok();

    status(
        &size,
        &if attached {
            format!("tmuxy browser [{session_name}] — attached; your own browser is the view. `:` for verbs")
        } else {
            format!("tmuxy browser [{session_name}] — `:` for verbs, ctrl+c to leave")
        },
    );

    // The frame drawer. Attached sessions draw nothing: the user is looking at
    // their own window, and painting a second copy would only compete with it.
    let done = Arc::new(AtomicBool::new(false));
    let drawer = if attached {
        None
    } else {
        match session.start_frames().await {
            Ok(frames) => Some(tokio::spawn(draw_loop(
                frames,
                size_rx.clone(),
                Arc::clone(&done),
            ))),
            Err(error) => {
                status(&size, &format!("error: {error}"));
                None
            }
        }
    };

    // A restored pane is handed the page it was on.
    if let Some(url) = goto {
        match session.run(verbs::Verb::Goto { url }).await {
            Ok(Output::Line(url)) => status(&size, &url),
            Ok(_) => {}
            Err(error) => status(&size, &format!("error: {error}")),
        }
    }

    // Opening on the current URL tells the user where the pane is pointed, and
    // forces the page to exist before the first frame is asked for.
    if let Ok(Output::Line(url)) = session.run(verbs::Verb::Url).await {
        status(&size, &url);
    }
    // Say how to come back — now, and after every verb (`run_line`).
    let url = current_url(&mut session).await;
    announce_restore(session_name, url.as_deref());

    let code = read_loop(&mut session, size_rx, attached, session_name).await;

    done.store(true, Ordering::Relaxed);
    resizes.abort();
    if let Some(drawer) = drawer {
        drawer.abort();
    }
    session.close().await;

    drop(raw);
    let mut stdout = std::io::stdout();
    let _ = write!(
        stdout,
        "{}{}{}",
        term::MOUSE_OFF,
        term::SHOW_CURSOR,
        term::ALT_SCREEN_OFF
    );
    let _ = stdout.flush();
    code
}

/// Publish the pane's size whenever the terminal says it changed.
///
/// `SIGWINCH` is how a terminal reports a resize, and tmux sends it when the
/// user drags a divider or zooms the pane. Re-reading the size rather than
/// trusting the signal's timing: several resizes during a drag collapse into
/// whatever the pane ended up being, which is the only size worth laying the
/// page out for.
#[cfg(unix)]
async fn watch_for_resize(sizes: tokio::sync::watch::Sender<PaneSize>) {
    let Ok(mut winch) =
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::window_change())
    else {
        return;
    };
    while winch.recv().await.is_some() {
        let size = pane_size();
        // `send_if_modified`, so a signal that changed nothing does not make
        // every watcher repaint and re-ask the engine for the same viewport.
        sizes.send_if_modified(|current| {
            if *current == size {
                false
            } else {
                *current = size;
                true
            }
        });
    }
}

/// Draw each frame as it arrives, and redraw periodically so a client that
/// attaches later sees the page too.
async fn draw_loop(
    mut frames: tokio::sync::watch::Receiver<super::session::Frame>,
    mut size: tokio::sync::watch::Receiver<PaneSize>,
    done: Arc<AtomicBool>,
) {
    loop {
        if done.load(Ordering::Relaxed) {
            return;
        }
        let frame = frames.borrow_and_update().clone();
        let current = *size.borrow_and_update();
        if !frame.is_empty() {
            let mut stdout = std::io::stdout();
            let _ = stdout.write_all(&draw_frame(&frame, current));
            let _ = stdout.flush();
        }
        // A new frame, a resize, or the keepalive redraw — see
        // REDRAW_INTERVAL. The resize matters here as well as in the read loop:
        // the picture's cell dimensions change with the pane, and drawing the
        // old size into the new pane leaves the page stretched until the page
        // next moves.
        let next = async {
            tokio::select! {
                changed = frames.changed() => changed.is_err(),
                changed = size.changed() => changed.is_err(),
            }
        };
        if tokio::time::timeout(REDRAW_INTERVAL, next)
            .await
            .is_ok_and(|ended| ended)
        {
            return;
        }
    }
}

/// Everything arriving from the terminal, as whole inputs.
///
/// One queue rather than a byte buffer each caller re-parses, because the two
/// readers — the key loop and the command line — hand control back and forth
/// mid-chunk. A terminal delivers whatever the kernel had ready, so typing
/// `:goto example.com` fast enough arrives as ONE read: the `:` and the rest of
/// the line are the same chunk. Parsing the chunk in one place and leaving the
/// rest queued is what makes that work; draining it into a local list and then
/// entering the command line threw the rest of the line away, which looked like
/// a pane that ignored anything typed quickly.
struct Inputs {
    rx: tokio::sync::mpsc::UnboundedReceiver<Vec<u8>>,
    buffer: Vec<u8>,
    queue: std::collections::VecDeque<Input>,
}

impl Inputs {
    /// Read from an arbitrary source of chunks. The seam the tests use, so the
    /// queue discipline can be exercised without a terminal.
    fn from_rx(rx: tokio::sync::mpsc::UnboundedReceiver<Vec<u8>>) -> Self {
        Self {
            rx,
            buffer: Vec::new(),
            queue: std::collections::VecDeque::new(),
        }
    }

    /// Start the reader thread. stdin is blocking and raw, so it gets a thread
    /// of its own rather than blocking the runtime the engine lives on.
    fn start() -> Self {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<Vec<u8>>();
        std::thread::spawn(move || {
            let mut stdin = std::io::stdin();
            let mut chunk = [0u8; 1024];
            loop {
                match stdin.read(&mut chunk) {
                    Ok(0) | Err(_) => return,
                    Ok(n) => {
                        if tx.send(chunk[..n].to_vec()).is_err() {
                            return;
                        }
                    }
                }
            }
        });
        Self::from_rx(rx)
    }

    /// The next input, or `None` when the terminal is gone.
    async fn next(&mut self) -> Option<Input> {
        loop {
            if let Some(input) = self.queue.pop_front() {
                return Some(input);
            }
            let chunk = self.rx.recv().await?;
            self.buffer.extend_from_slice(&chunk);
            self.queue.extend(take_inputs(&mut self.buffer));
        }
    }

    /// Whether an input is already waiting, without taking it.
    fn has_ready(&self) -> bool {
        !self.queue.is_empty()
    }
}

/// Read the terminal until the user leaves.
async fn read_loop(
    session: &mut Session,
    mut sizes: tokio::sync::watch::Receiver<PaneSize>,
    attached: bool,
    session_name: &str,
) -> i32 {
    let mut inputs = Inputs::start();
    let mut size = *sizes.borrow_and_update();
    loop {
        let input = tokio::select! {
            input = inputs.next() => match input {
                Some(input) => input,
                None => return 0,
            },
            changed = sizes.changed() => {
                if changed.is_err() {
                    return 0;
                }
                size = *sizes.borrow_and_update();
                // The page lays out against the pane, so a resize has to reach
                // the engine — this is the whole reason the read loop watches.
                let (vw, vh) = size.viewport();
                if let Err(error) = session.set_viewport(vw, vh, 1.0).await {
                    status(&size, &format!("error: {error}"));
                }
                continue;
            }
        };

        match input {
            Input::Key(key) if key.as_slice() == b"\x03" => return 0, // ctrl+c
            Input::Key(key) if key.as_slice() == b":" => {
                match command_mode(session, size, &mut inputs, session_name).await {
                    CommandOutcome::Continue => {}
                    CommandOutcome::Quit => return 0,
                }
            }
            Input::Key(key) => {
                if !attached {
                    forward_key(session, &key).await;
                }
            }
            Input::Mouse {
                button,
                col,
                row,
                pressed,
            } => {
                if !attached {
                    forward_mouse(session, size, button, col, row, pressed).await;
                }
            }
        }
    }
}

enum CommandOutcome {
    Continue,
    Quit,
}

/// Read a verb line on the status row and run it.
///
/// A line editor rather than a key-at-a-time forward: this is the one place the
/// user is typing AT tmuxy rather than at the page, so it behaves like a prompt.
async fn command_mode(
    session: &mut Session,
    size: PaneSize,
    inputs: &mut Inputs,
    session_name: &str,
) -> CommandOutcome {
    let mut line = String::new();
    loop {
        // Only redraw the prompt when nothing is already waiting: a whole line
        // pasted or typed fast would otherwise repaint the status row once per
        // character.
        if !inputs.has_ready() {
            status(&size, &format!(":{line}"));
        }
        let Some(input) = inputs.next().await else {
            return CommandOutcome::Quit;
        };
        let Input::Key(key) = input else { continue };
        match key.as_slice() {
            b"\x03" => return CommandOutcome::Quit,
            b"\x1b" => {
                status(&size, "");
                return CommandOutcome::Continue;
            }
            b"\r" | b"\n" => return run_line(session, size, &line, session_name).await,
            b"\x7f" | b"\x08" => {
                line.pop();
            }
            other => {
                if let Ok(text) = std::str::from_utf8(other) {
                    if !text.chars().any(char::is_control) {
                        line.push_str(text);
                    }
                }
            }
        }
    }
}

/// Run one verb line and show what it said.
async fn run_line(
    session: &mut Session,
    size: PaneSize,
    line: &str,
    session_name: &str,
) -> CommandOutcome {
    if matches!(line.trim(), "q" | "quit" | "exit") {
        return CommandOutcome::Quit;
    }
    match verbs::parse(line) {
        Ok(verb) => match session.run(verb).await {
            Ok(output) => {
                let text = output.to_string();
                // One line: the status row is one line, and an agent reading it
                // back with `capture-pane` wants the answer, not a paragraph.
                let first = text.lines().next().unwrap_or("").to_string();
                status(&size, &first);
                // The page may have moved; the restore tag follows it.
                let url = current_url(session).await;
                announce_restore(session_name, url.as_deref());
            }
            Err(error) => status(&size, &format!("error: {error}")),
        },
        Err(verbs::ParseError::Empty) => status(&size, ""),
        Err(error) => status(&size, &format!("error: {error}")),
    }
    CommandOutcome::Continue
}

/// Write the status row, leaving the picture alone.
fn status(size: &PaneSize, text: &str) {
    let mut stdout = std::io::stdout();
    let width = usize::from(size.cols);
    let shown: String = text.chars().take(width).collect();
    // Move to the status row, clear it, write, and leave the cursor there —
    // anywhere else and the next frame would anchor its picture in the wrong
    // place.
    let _ = write!(stdout, "\x1b[{};1H\x1b[2K{}", size.rows, shown);
    let _ = stdout.flush();
}

/// Forward one key to the page.
pub async fn forward_key(session: &mut Session, key: &[u8]) {
    let Ok(text) = std::str::from_utf8(key) else {
        return;
    };
    let (name, typed) = key_name(text);
    let mut params = DispatchKeyEventParams::builder()
        .r#type(if typed.is_some() {
            DispatchKeyEventType::KeyDown
        } else {
            DispatchKeyEventType::RawKeyDown
        })
        .key(name.clone());
    if let Some(text) = &typed {
        params = params.text(text.clone());
    }
    let Ok(down) = params.build() else { return };
    let _ = session.page().execute(down).await;

    if let Ok(up) = DispatchKeyEventParams::builder()
        .r#type(DispatchKeyEventType::KeyUp)
        .key(name)
        .build()
    {
        let _ = session.page().execute(up).await;
    }
}

/// A terminal key as the name CDP wants, and the text it types (if any).
///
/// `text` is what decides whether a key TYPES or only moves the caret, and it
/// must be absent for a named key: sending `text: "ArrowLeft"` inserts that word
/// into whatever has focus.
pub fn key_name(key: &str) -> (String, Option<String>) {
    match key {
        "\x1b[A" => ("ArrowUp".into(), None),
        "\x1b[B" => ("ArrowDown".into(), None),
        "\x1b[C" => ("ArrowRight".into(), None),
        "\x1b[D" => ("ArrowLeft".into(), None),
        "\x1b[H" => ("Home".into(), None),
        "\x1b[F" => ("End".into(), None),
        "\x1b[5~" => ("PageUp".into(), None),
        "\x1b[6~" => ("PageDown".into(), None),
        "\x1b[3~" => ("Delete".into(), None),
        "\x1b" => ("Escape".into(), None),
        "\r" | "\n" => ("Enter".into(), Some("\r".into())),
        "\t" => ("Tab".into(), None),
        "\x7f" | "\x08" => ("Backspace".into(), None),
        other => {
            if other.chars().count() == 1 && !other.chars().any(char::is_control) {
                (other.to_string(), Some(other.to_string()))
            } else {
                (other.to_string(), None)
            }
        }
    }
}

/// Forward one mouse report to the page.
pub async fn forward_mouse(
    session: &mut Session,
    size: PaneSize,
    button: u16,
    col: u16,
    row: u16,
    pressed: bool,
) {
    // The status row is tmuxy's, not the page's.
    if row > size.image_rows() {
        return;
    }
    let (x, y) = cell_to_page(col, row, size);

    let params = match decode_button(button) {
        ButtonMeaning::Wheel { up } => DispatchMouseEventParams::builder()
            .r#type(DispatchMouseEventType::MouseWheel)
            .x(x)
            .y(y)
            // CDP's deltaY is the distance the CONTENT moves, which is the
            // opposite sign from "the wheel went up".
            .delta_x(0.0)
            .delta_y(if up { WHEEL_STEP } else { -WHEEL_STEP })
            .build(),
        ButtonMeaning::Button { button, dragging } => DispatchMouseEventParams::builder()
            .r#type(if dragging {
                DispatchMouseEventType::MouseMoved
            } else if pressed {
                DispatchMouseEventType::MousePressed
            } else {
                DispatchMouseEventType::MouseReleased
            })
            .x(x)
            .y(y)
            .button(button)
            .click_count(if dragging { 0 } else { 1 })
            .build(),
        ButtonMeaning::Release => DispatchMouseEventParams::builder()
            .r#type(DispatchMouseEventType::MouseReleased)
            .x(x)
            .y(y)
            .button(MouseButton::Left)
            .click_count(1)
            .build(),
        ButtonMeaning::Ignored => return,
    };

    if let Ok(params) = params {
        let _ = session.page().execute(params).await;
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn the_status_row_is_not_part_of_the_picture() {
        let size = PaneSize {
            cols: 80,
            rows: 24,
            cell_w: 8,
            cell_h: 16,
        };
        assert_eq!(size.image_rows(), 23, "one row is kept for status");
        assert_eq!(size.viewport(), (640, 368));
    }

    /// A one-row pane would otherwise ask for a zero-height viewport, which
    /// makes Chromium stop painting entirely.
    #[test]
    fn a_tiny_pane_still_asks_for_a_usable_viewport() {
        let size = PaneSize {
            cols: 1,
            rows: 1,
            cell_w: 8,
            cell_h: 16,
        };
        assert_eq!(size.image_rows(), 1);
        assert!(size.viewport().1 > 0);
    }

    #[test]
    fn a_frame_is_drawn_home_so_it_replaces_the_last_one() {
        let size = PaneSize {
            cols: 10,
            rows: 5,
            cell_w: 8,
            cell_h: 16,
        };
        let drawn = String::from_utf8(draw_frame(b"\xff\xd8\xff", size)).unwrap();
        assert!(
            drawn.starts_with("\x1b[H"),
            "the cursor must be home, or tmuxy anchors the picture somewhere new each time"
        );
        assert!(drawn.contains("width=10;height=4"), "{drawn}");
        assert!(drawn.ends_with('\x07'), "the OSC must be terminated");
        assert!(drawn.contains("inline=1"), "{drawn}");
    }

    #[test]
    fn a_whole_mouse_report_is_one_input() {
        let mut buf = b"\x1b[<0;12;7M".to_vec();
        assert_eq!(
            take_inputs(&mut buf),
            vec![Input::Mouse {
                button: 0,
                col: 12,
                row: 7,
                pressed: true
            }]
        );
        assert!(buf.is_empty());
    }

    #[test]
    fn a_release_is_told_from_a_press() {
        let mut buf = b"\x1b[<0;1;1m".to_vec();
        assert_eq!(
            take_inputs(&mut buf),
            vec![Input::Mouse {
                button: 0,
                col: 1,
                row: 1,
                pressed: false
            }]
        );
    }

    /// The bug this guards: half a mouse report read as keys types its digits
    /// and semicolons into the page.
    #[test]
    fn a_split_mouse_report_waits_for_its_rest() {
        let mut buf = b"\x1b[<0;12".to_vec();
        assert!(take_inputs(&mut buf).is_empty(), "nothing is complete yet");
        buf.extend_from_slice(b";7M");
        assert_eq!(
            take_inputs(&mut buf),
            vec![Input::Mouse {
                button: 0,
                col: 12,
                row: 7,
                pressed: true
            }]
        );
    }

    #[test]
    fn keys_and_mouse_interleave_without_losing_either() {
        let mut buf = b"a\x1b[<0;2;3Mb".to_vec();
        assert_eq!(
            take_inputs(&mut buf),
            vec![
                Input::Key(b"a".to_vec()),
                Input::Mouse {
                    button: 0,
                    col: 2,
                    row: 3,
                    pressed: true
                },
                Input::Key(b"b".to_vec()),
            ]
        );
    }

    /// An arrow key is one key, not `[` followed by `A`.
    #[test]
    fn an_escape_sequence_arrives_as_one_key() {
        let mut buf = b"\x1b[A".to_vec();
        assert_eq!(take_inputs(&mut buf), vec![Input::Key(b"\x1b[A".to_vec())]);
    }

    /// A bare ESC is held back: its sequence may still be arriving, and
    /// splitting it would type `[` and `A` into the page.
    #[test]
    fn a_lone_escape_waits() {
        let mut buf = b"\x1b".to_vec();
        assert!(take_inputs(&mut buf).is_empty());
        buf.extend_from_slice(b"[D");
        assert_eq!(take_inputs(&mut buf), vec![Input::Key(b"\x1b[D".to_vec())]);
    }

    #[test]
    fn a_multibyte_character_is_not_split() {
        let mut buf = "é".as_bytes().to_vec();
        buf.truncate(1);
        assert!(take_inputs(&mut buf).is_empty(), "half a character waits");
        buf.extend_from_slice(&"é".as_bytes()[1..]);
        assert_eq!(
            take_inputs(&mut buf),
            vec![Input::Key("é".as_bytes().to_vec())]
        );
    }

    /// The centre of the cell, so a click aimed at a link lands in it.
    #[test]
    fn a_cell_maps_to_the_middle_of_itself() {
        let size = PaneSize {
            cols: 80,
            rows: 24,
            cell_w: 8,
            cell_h: 16,
        };
        assert_eq!(cell_to_page(1, 1, size), (4.0, 8.0));
        assert_eq!(cell_to_page(2, 3, size), (12.0, 40.0));
    }

    #[test]
    fn the_sgr_button_codes_mean_what_they_say() {
        assert_eq!(
            decode_button(0),
            ButtonMeaning::Button {
                button: MouseButton::Left,
                dragging: false
            }
        );
        assert_eq!(
            decode_button(2),
            ButtonMeaning::Button {
                button: MouseButton::Right,
                dragging: false
            }
        );
        // 32 is the motion bit: a drag, not a fresh press.
        assert_eq!(
            decode_button(32),
            ButtonMeaning::Button {
                button: MouseButton::Left,
                dragging: true
            }
        );
        assert_eq!(decode_button(64), ButtonMeaning::Wheel { up: true });
        assert_eq!(decode_button(65), ButtonMeaning::Wheel { up: false });
        assert_eq!(decode_button(3), ButtonMeaning::Release);
    }

    /// `text` present means the key TYPES. Sending it for a named key inserts
    /// the word "ArrowLeft" into whatever has focus.
    #[test]
    fn only_a_printable_key_carries_text() {
        assert_eq!(key_name("a"), ("a".to_string(), Some("a".to_string())));
        assert_eq!(key_name("\x1b[D"), ("ArrowLeft".to_string(), None));
        assert_eq!(key_name("\t"), ("Tab".to_string(), None));
        assert_eq!(key_name("\x7f"), ("Backspace".to_string(), None));
        assert_eq!(key_name("\r").0, "Enter");
    }

    /// A whole line typed fast arrives as ONE read, and every input in it must
    /// survive. The bug this guards cost the rest of the line: the key loop
    /// drained the chunk into a list, saw the `:`, and handed control to the
    /// command line — which then read from an empty buffer and waited, while the
    /// `goto example.com` it was waiting for sat in a list nobody would look at
    /// again. Typing slowly worked; typing at speed, or pasting, did not.
    #[tokio::test]
    async fn a_whole_line_in_one_chunk_survives_a_handover() {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<Vec<u8>>();
        let mut inputs = Inputs::from_rx(rx);
        tx.send(b":goto example.com\r".to_vec()).expect("send");
        drop(tx);

        let mut seen = Vec::new();
        while let Some(Input::Key(key)) = inputs.next().await {
            seen.push(String::from_utf8_lossy(&key).to_string());
        }
        assert_eq!(seen.first().map(String::as_str), Some(":"));
        assert_eq!(
            seen[1..].concat(),
            "goto example.com\r",
            "the rest of the line must still be there after the `:` is taken"
        );
    }

    /// The tag is handed to the CLI, which is what makes it a run-shell write,
    /// and it carries the page: that is what a snapshot hands back.
    #[test]
    fn the_restore_tag_is_handed_to_the_cli_with_the_page() {
        let argv = restore_tag_args("%7", "notes", Some("https://example.com/a b"));
        assert_eq!(argv[0], "pane");
        assert_eq!(argv[1], "restore-cmd");
        assert_eq!(argv[3], "%7");
        assert!(
            argv[2].starts_with("tmuxy browser --repl --session 'notes'"),
            "{}",
            argv[2]
        );
        assert!(
            argv[2].ends_with("--goto 'https://example.com/a b'"),
            "{}",
            argv[2]
        );
        let bare = restore_tag_args("%1", "x", None);
        assert_eq!(bare[2], "tmuxy browser --repl --session 'x'");
    }

    #[test]
    fn the_cell_size_override_is_read_as_wxh() {
        assert_eq!(parse_cell_px("9x18"), Some((9, 18)));
        assert_eq!(parse_cell_px("10X20"), Some((10, 20)));
        assert_eq!(parse_cell_px("nonsense"), None);
        assert_eq!(parse_cell_px(""), None);
    }
}
