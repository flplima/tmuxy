use std::io::Read;
use std::os::fd::AsRawFd;

use chromiumoxide::cdp::browser_protocol::input::{
    DispatchKeyEventParams, DispatchKeyEventType, DispatchMouseEventParams, DispatchMouseEventType,
    MouseButton,
};

use super::{Layout, PICTURE_TOP};
use crate::browser::session::Session;

/// Put the terminal in raw mode for as long as this lives.
///
/// Raw because every key belongs to the page: line discipline would hold input
/// until Enter, echo it over the picture, and swallow ctrl+c instead of letting
/// the program decide what it means.
pub(super) struct RawMode {
    fd: i32,
    original: libc::termios,
}

impl RawMode {
    pub(super) fn enter() -> std::io::Result<Self> {
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
pub(super) fn take_inputs(buffer: &mut Vec<u8>) -> Vec<Input> {
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
pub(super) fn cell_to_page(col: u16, row: u16, layout: Layout) -> (f64, f64) {
    let across = (f64::from(col.saturating_sub(layout.col)) + 0.5) / f64::from(layout.cols);
    let down = (f64::from(row.saturating_sub(PICTURE_TOP)) + 0.5) / f64::from(layout.rows);
    (
        across * f64::from(layout.page_w),
        down * f64::from(layout.page_h),
    )
}

/// Whether a cell is on the picture, rather than on the toolbar, the status
/// row, or the margin beside a fixed-size page.
pub(super) fn on_picture(col: u16, row: u16, layout: Layout) -> bool {
    (layout.col..layout.col + layout.cols).contains(&col)
        && (PICTURE_TOP..PICTURE_TOP + layout.rows).contains(&row)
}

/// An SGR button code as what it means to a page.
///
/// The low two bits are the button, bit 5 (32) marks motion, and 64 marks a
/// wheel event where the low bits become the direction.
pub(super) fn decode_button(code: u16) -> ButtonMeaning {
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
pub(super) enum ButtonMeaning {
    Button { button: MouseButton, dragging: bool },
    Wheel { up: bool },
    Release,
    Ignored,
}

/// How far one wheel notch scrolls the page.
const WHEEL_STEP: f64 = 120.0;

/// CDP's `deltaY` has the DOM's sign: positive scrolls the page DOWN, the way
/// a wheel turned towards you does. Wheel up is therefore negative.
pub(super) fn wheel_delta_y(up: bool) -> f64 {
    if up {
        -WHEEL_STEP
    } else {
        WHEEL_STEP
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
pub(super) struct Inputs {
    rx: tokio::sync::mpsc::UnboundedReceiver<Vec<u8>>,
    buffer: Vec<u8>,
    queue: std::collections::VecDeque<Input>,
}

impl Inputs {
    /// Read from an arbitrary source of chunks. The seam the tests use, so the
    /// queue discipline can be exercised without a terminal.
    pub(super) fn from_rx(rx: tokio::sync::mpsc::UnboundedReceiver<Vec<u8>>) -> Self {
        Self {
            rx,
            buffer: Vec::new(),
            queue: std::collections::VecDeque::new(),
        }
    }

    /// Start the reader thread. stdin is blocking and raw, so it gets a thread
    /// of its own rather than blocking the runtime the engine lives on.
    pub(super) fn start() -> Self {
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
    pub(super) async fn next(&mut self) -> Option<Input> {
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
    pub(super) fn has_ready(&self) -> bool {
        !self.queue.is_empty()
    }
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
pub(super) fn key_name(key: &str) -> (String, Option<String>) {
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
    layout: Layout,
    button: u16,
    col: u16,
    row: u16,
    pressed: bool,
) {
    // The toolbar row and a fixed page's margins are tmuxy's, not the page's.
    if !on_picture(col, row, layout) {
        return;
    }
    let (x, y) = cell_to_page(col, row, layout);
    let (x, y) = (x * session.view_scale(), y * session.view_scale());

    let params = match decode_button(button) {
        ButtonMeaning::Wheel { up } => DispatchMouseEventParams::builder()
            .r#type(DispatchMouseEventType::MouseWheel)
            .x(x)
            .y(y)
            .delta_x(0.0)
            .delta_y(wheel_delta_y(up))
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

/// Read the terminal until the user leaves.
pub(super) async fn read_loop(
    session: &mut Session,
    mut sizes: tokio::sync::watch::Receiver<super::PaneSize>,
    viewport: tokio::sync::watch::Sender<crate::browser::verbs::Viewport>,
    repl: tokio::sync::watch::Sender<bool>,
    log: super::ui::ReplLog,
) -> i32 {
    use super::ui::{command_mode, status, CommandOutcome, View};
    use crate::browser::verbs::Viewport;

    let mut inputs = Inputs::start();
    let mut size = *sizes.borrow_and_update();
    let mut view = View {
        viewport,
        repl,
        log,
    };
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
                let current = *view.viewport.borrow();
                let page = super::layout(size, current);
                if let Err(error) = session
                    .set_viewport(page.page_w, page.page_h, current == Viewport::Mobile)
                    .await
                {
                    status(&size, &format!("error: {error}"));
                }
                if view.showing_repl() {
                    view.redraw(&size);
                }
                continue;
            }
        };

        let showing_repl = view.showing_repl();
        match input {
            Input::Key(key) if key.as_slice() == b"\x03" => return 0, // ctrl+c
            // In the REPL view every key is typed at the prompt; `:` is the
            // prompt's own character and starts it either way.
            Input::Key(key) if key.as_slice() == b":" || showing_repl => {
                let first = (key.as_slice() != b":").then_some(key);
                match command_mode(session, size, &mut view, &mut inputs, first).await {
                    CommandOutcome::Continue => {}
                    CommandOutcome::Quit => return 0,
                }
            }
            Input::Key(key) => forward_key(session, &key).await,
            Input::Mouse {
                button,
                col,
                row,
                pressed,
            } => {
                // The picture is what a click lands on; the log is text.
                if !showing_repl {
                    let page = super::layout(size, *view.viewport.borrow());
                    forward_mouse(session, page, button, col, row, pressed).await;
                }
            }
        }
    }
}
