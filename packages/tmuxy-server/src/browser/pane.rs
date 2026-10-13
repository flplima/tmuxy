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
//! ## The toolbar row, and why there is a status row
//!
//! The top line is the app's: the pane tags itself `@tmuxy-pane-widget
//! browser-live` and writes a short header there (`header_line`), and the UI
//! draws its address bar over that row — back, forward, refresh, the address,
//! open externally. The address itself travels as the pane's TITLE (OSC 2),
//! because a URL is longer than a row and tmux keeps a title whole. The bar's
//! buttons drive this program the way anything else does: they type `:back`,
//! `:goto …` into the pane.
//!
//! The bottom line carries verb output, so an agent driving the pane with
//! `tmuxy pane send` can read the answer back with `tmuxy pane capture`. That
//! is the entire agent protocol; it needs no API. The person looking at the
//! pane never sees it: the picture covers that row, and the app hides a live
//! browser's text altogether — the grid is for scripts, the picture for people.

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
use super::verbs::{self, Viewport};

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
    pub(super) const ALT_SCREEN_ON: &str = "\x1b[?1049h";
    pub(super) const ALT_SCREEN_OFF: &str = "\x1b[?1049l";
    /// Button-event tracking (press, release, drag) plus SGR coordinates. 1002
    /// rather than 1003: motion with no button down would be a report per cell
    /// crossed, which is a lot of traffic for hover alone.
    pub(super) const MOUSE_ON: &str = "\x1b[?1002h\x1b[?1006h";
    pub(super) const MOUSE_OFF: &str = "\x1b[?1006l\x1b[?1002l";
    pub(super) const HIDE_CURSOR: &str = "\x1b[?25l";
    pub(super) const SHOW_CURSOR: &str = "\x1b[?25h";
    pub(super) const CLEAR: &str = "\x1b[2J";
}

/// The pane's size, in cells and in the pixels a page should lay out against.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PaneSize {
    pub cols: u16,
    pub rows: u16,
    pub cell_w: u16,
    pub cell_h: u16,
}

/// The first row of the picture (1-indexed): row 1 is the toolbar's.
const PICTURE_TOP: u16 = 2;

impl PaneSize {
    /// The rows the picture occupies: everything under the toolbar row. The
    /// status row is the last of them: the picture covers it, so verb output
    /// is there for `tmuxy pane capture` without ever being in the way.
    fn image_rows(&self) -> u16 {
        self.rows.saturating_sub(1).max(1)
    }
}

/// Where the picture sits in the pane, and the page size it shows.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Layout {
    /// The picture's first column (1-indexed).
    pub col: u16,
    /// Its size in cells, from `PICTURE_TOP`.
    pub cols: u16,
    pub rows: u16,
    /// The viewport the page lays out in, in CSS pixels.
    pub page_w: u32,
    pub page_h: u32,
}

/// The picture's place for this pane and viewport.
///
/// `Auto` fills the picture area and lays the page out for it. A fixed size is
/// shown at its own aspect, centred: its cells are worked out from the cell
/// size the page is laid out against, so a phone-shaped page stays a phone.
pub fn layout(size: PaneSize, viewport: Viewport) -> Layout {
    let area_cols = size.cols.max(1);
    let area_rows = size.image_rows();
    let (cell_w, cell_h) = (f64::from(size.cell_w), f64::from(size.cell_h));
    match viewport.size() {
        None => Layout {
            col: 1,
            cols: area_cols,
            rows: area_rows,
            page_w: u32::from(area_cols) * u32::from(size.cell_w),
            page_h: u32::from(area_rows) * u32::from(size.cell_h),
        },
        Some((page_w, page_h)) => {
            let scale = (f64::from(area_cols) * cell_w / f64::from(page_w))
                .min(f64::from(area_rows) * cell_h / f64::from(page_h));
            let fit = |pixels: u32, cell: f64, most: u16| -> u16 {
                let cells = (f64::from(pixels) * scale / cell).round();
                (cells.max(1.0) as u16).min(most)
            };
            let cols = fit(page_w, cell_w, area_cols);
            let rows = fit(page_h, cell_h, area_rows);
            Layout {
                col: 1 + (area_cols - cols) / 2,
                cols,
                rows,
                page_w,
                page_h,
            }
        }
    }
}

/// Read the pane's size from the terminal, falling back to a usable default.
///
/// `TIOCGWINSZ` is the only thing that knows, and its pixel fields are usually
/// zero under tmux — hence the fallback and the override.
fn pane_size() -> PaneSize {
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
/// The cursor goes to the picture's top-left first (row 2, under the toolbar).
/// That is what makes the redraw REPLACE rather than accumulate: tmuxy anchors
/// a placement at the cursor and swaps whatever was already anchored there.
///
/// `preserveAspectRatio=0` makes the picture fill its cells exactly. The page
/// is laid out for an ASSUMED cell size (the viewer's real one never reaches
/// the pty), so its aspect rarely matches the pane's; fitted, the picture was
/// letterboxed, and a click — mapped cell to page pixel as if the picture
/// filled the cells — landed up to a few rows away from what was under it.
fn draw_frame(frame: &[u8], layout: Layout) -> Vec<u8> {
    use base64::Engine as _;
    let encoded = base64::engine::general_purpose::STANDARD.encode(frame);
    format!(
        "{}\x1b[{PICTURE_TOP};{}H\x1b]1337;File=inline=1;width={};height={};preserveAspectRatio=0:{}\x07",
        // Re-asserted with every frame: a client that attached after the
        // program hid its cursor never saw that escape.
        term::HIDE_CURSOR,
        layout.col,
        layout.cols,
        layout.rows,
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
fn take_inputs(buffer: &mut Vec<u8>) -> Vec<Input> {
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
fn cell_to_page(col: u16, row: u16, layout: Layout) -> (f64, f64) {
    let across = (f64::from(col.saturating_sub(layout.col)) + 0.5) / f64::from(layout.cols);
    let down = (f64::from(row.saturating_sub(PICTURE_TOP)) + 0.5) / f64::from(layout.rows);
    (
        across * f64::from(layout.page_w),
        down * f64::from(layout.page_h),
    )
}

/// Whether a cell is on the picture, rather than on the toolbar, the status
/// row, or the margin beside a fixed-size page.
fn on_picture(col: u16, row: u16, layout: Layout) -> bool {
    (layout.col..layout.col + layout.cols).contains(&col)
        && (PICTURE_TOP..PICTURE_TOP + layout.rows).contains(&row)
}

/// An SGR button code as what it means to a page.
///
/// The low two bits are the button, bit 5 (32) marks motion, and 64 marks a
/// wheel event where the low bits become the direction.
fn decode_button(code: u16) -> ButtonMeaning {
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
enum ButtonMeaning {
    Button { button: MouseButton, dragging: bool },
    Wheel { up: bool },
    Release,
    Ignored,
}

/// How far one wheel notch scrolls the page.
const WHEEL_STEP: f64 = 120.0;

/// CDP's `deltaY` has the DOM's sign: positive scrolls the page DOWN, the way
/// a wheel turned towards you does. Wheel up is therefore negative.
fn wheel_delta_y(up: bool) -> f64 {
    if up {
        -WHEEL_STEP
    } else {
        WHEEL_STEP
    }
}

/// Run a browser pane until the user leaves it.
/// How to bring this pane back, as the `tmuxy` CLI is told it
/// (`tmuxy pane restore-cmd '<line>' <pane>` → `@tmuxy-pane-restore`, see
/// `tmuxy_core::session_snapshot`).
///
/// The CLI, never tmux directly: a mutating tmux command from inside a pane
/// while control mode is attached crashes tmux 3.5a (docs/TMUX.md), and the
/// CLI is the one place that knows to wrap it in `run-shell`.
///
/// The session is written back only when one was NAMED: the default is the
/// pane's own (`pane-<id>`), and a restored pane has a new id — handing it the
/// old one would make it share a profile with whichever pane has that id now.
fn restore_tag_args(
    pane: &str,
    named_session: Option<&str>,
    color_filter: bool,
    viewport: Viewport,
    url: Option<&str>,
) -> Vec<String> {
    let mut line = "tmuxy browser".to_string();
    if let Some(session) = named_session {
        line.push_str(" --session ");
        line.push_str(&shell_quote(session));
    }
    if color_filter {
        line.push_str(" --color-filter");
    }
    if viewport != Viewport::Auto {
        line.push_str(" --viewport ");
        line.push_str(viewport.name());
    }
    if let Some(url) = url {
        line.push(' ');
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
fn announce_restore(
    named_session: Option<&str>,
    color_filter: bool,
    viewport: Viewport,
    url: Option<&str>,
) {
    let Some(pane) = std::env::var_os("TMUX_PANE") else {
        return;
    };
    tmuxy_cli(&restore_tag_args(
        &pane.to_string_lossy(),
        named_session,
        color_filter,
        viewport,
        url,
    ));
}

/// Run the `tmuxy` CLI with these arguments, quietly.
///
/// `TMUXY_CLI` is set by the CLI when it starts this program, so the pane
/// reaches the same `tmuxy` that launched it wherever it is installed; a pane
/// started some other way falls back to `tmuxy` on the PATH.
fn tmuxy_cli(args: &[String]) {
    let cli = std::env::var_os("TMUXY_CLI").unwrap_or_else(|| "tmuxy".into());
    let _ = std::process::Command::new(cli)
        .args(args)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();
}

/// The pane tag that makes the app draw the toolbar over row 1.
pub const LIVE_WIDGET: &str = "browser-live";

/// Tag this pane (or untag it) as a live browser, through the CLI — the same
/// out-of-band authorisation `tmuxy-widget` gives a widget: no output can set
/// it, so no output can put a toolbar over a pane that did not ask for one.
fn tag_pane(on: bool) {
    let Some(pane) = std::env::var_os("TMUX_PANE") else {
        return;
    };
    tmuxy_cli(&widget_tag_args(&pane.to_string_lossy(), on));
}

/// Tell the app's address bar where the page is (`@tmuxy-pane-url`), or
/// that it is nowhere. Through the CLI, like the widget tag.
fn tag_url(url: Option<&str>) {
    let Some(pane) = std::env::var_os("TMUX_PANE") else {
        return;
    };
    tmuxy_cli(&url_tag_args(&pane.to_string_lossy(), url));
}

fn url_tag_args(pane: &str, url: Option<&str>) -> Vec<String> {
    let mut args: Vec<String> = vec!["run".into(), "set-option".into(), "-p".into()];
    if url.is_none() {
        args.push("-u".into());
    }
    args.extend(["-t".into(), pane.into(), "@tmuxy-pane-url".into()]);
    if let Some(url) = url {
        args.push(url.into());
    }
    args
}

fn widget_tag_args(pane: &str, on: bool) -> Vec<String> {
    let mut args: Vec<String> = vec!["run".into(), "set-option".into(), "-p".into()];
    if !on {
        args.push("-u".into());
    }
    args.extend(["-t".into(), pane.into(), "@tmuxy-pane-widget".into()]);
    if on {
        args.push(LIVE_WIDGET.into());
    }
    args
}

/// Where the page is and which way history can go: what the toolbar shows.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct Navigation {
    url: String,
    title: String,
    can_go_back: bool,
    can_go_forward: bool,
}

/// The toolbar row's text. The UI reads it to know this is a live browser and
/// which buttons are live; the address is the pane title (see the module doc).
/// Kept short so it never wraps into the picture.
fn header_line(nav: &Navigation, color_filter: bool, viewport: Viewport) -> String {
    let bit = |b: bool| if b { '1' } else { '0' };
    let size = match viewport {
        Viewport::Auto => 'a',
        Viewport::Desktop => 'd',
        Viewport::Mobile => 'm',
    };
    format!(
        "{HEADER_PREFIX}{}{}{}{size}",
        bit(nav.can_go_back),
        bit(nav.can_go_forward),
        bit(color_filter)
    )
}

/// What the toolbar row starts with (`header_line`).
const HEADER_PREFIX: &str = "tmuxy:browser ";

/// Write the toolbar row and the title that carries the address.
fn header(size: &PaneSize, nav: &Navigation, color_filter: bool, viewport: Viewport) {
    // The pane is named after the page, the way a browser tab is; the address
    // has a tag of its own (`@tmuxy-pane-url`). A page with no `<title>` is
    // called by its address.
    let name = if nav.title.trim().is_empty() {
        &nav.url
    } else {
        &nav.title
    };
    let title: String = name.chars().filter(|c| !c.is_control()).collect();
    write_out(&format!(
        "\x1b]2;{title}\x07\x1b[1;1H\x1b[2K{}\x1b[{};1H",
        header_line(nav, color_filter, viewport),
        size.rows
    ));
}

/// One write to the terminal, whole: the frame drawer, the toolbar and the
/// status row write from different tasks, and an escape torn in half by
/// another's would land text in the picture.
fn write_out(text: &str) {
    let mut stdout = std::io::stdout().lock();
    let _ = stdout.write_all(text.as_bytes());
    let _ = stdout.flush();
}

/// How often the toolbar asks the page where it is. A link followed inside the
/// page moves it without telling anyone, and the address bar should follow.
const NAVIGATION_POLL: std::time::Duration = std::time::Duration::from_millis(500);

/// Where the page is now, from the engine's own history.
async fn navigation(page: &chromiumoxide::page::Page) -> Option<Navigation> {
    use chromiumoxide::cdp::browser_protocol::page::GetNavigationHistoryParams;
    let history = page
        .execute(GetNavigationHistoryParams::default())
        .await
        .ok()?
        .result
        .clone();
    let index = usize::try_from(history.current_index).ok()?;
    let entry = history.entries.get(index)?;
    Some(Navigation {
        url: entry.url.clone(),
        title: entry.title.clone(),
        can_go_back: history.entries[..index].iter().any(|e| is_page(&e.url)),
        can_go_forward: index + 1 < history.entries.len(),
    })
}

/// A history entry worth going back to. Every tab starts on `about:blank`, so
/// the first page a pane opens would otherwise offer "back" to nothing.
fn is_page(url: &str) -> bool {
    !url.is_empty() && url != "about:blank"
}

/// Keep the toolbar row and the address current: on a navigation, and after a
/// resize (which clears nothing, but tmux reflows the row).
async fn header_loop(
    page: chromiumoxide::page::Page,
    mut size: tokio::sync::watch::Receiver<PaneSize>,
    mut viewport: tokio::sync::watch::Receiver<Viewport>,
    color_filter: bool,
    named_session: Option<String>,
    done: Arc<AtomicBool>,
) {
    let mut shown: Option<Navigation> = None;
    loop {
        if done.load(Ordering::Relaxed) {
            return;
        }
        let resized = size.has_changed().unwrap_or(false);
        let resized_page = viewport.has_changed().unwrap_or(false);
        let current = *size.borrow_and_update();
        let current_viewport = *viewport.borrow_and_update();
        if let Some(nav) = navigation(&page).await {
            let moved = shown.as_ref().map(|n| &n.url) != Some(&nav.url);
            if resized || resized_page || shown.as_ref() != Some(&nav) {
                header(&current, &nav, color_filter, current_viewport);
            }
            if moved || resized_page {
                // The page moved, by a verb or by a link inside it, or changed
                // size; the address bar and the restore tag follow it.
                let url = is_page(&nav.url).then_some(nav.url.as_str());
                if moved {
                    tag_url(url);
                }
                announce_restore(
                    named_session.as_deref(),
                    color_filter,
                    current_viewport,
                    url,
                );
            }
            shown = Some(nav);
        }
        tokio::time::sleep(NAVIGATION_POLL).await;
    }
}

/// Run a browser pane until the user leaves it.
pub async fn run(
    state_dir: &Path,
    session_name: &str,
    named_session: bool,
    attach: Option<String>,
    goto: Option<String>,
    color_filter: bool,
    viewport: Viewport,
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
    let first = layout(size, viewport);
    if let Err(error) = session
        .set_viewport(first.page_w, first.page_h, viewport == Viewport::Mobile)
        .await
    {
        eprintln!("tmuxy browser: {error}");
    }
    let (viewport_tx, viewport_rx) = tokio::sync::watch::channel(viewport);

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
    tag_pane(true);
    header(&size, &Navigation::default(), color_filter, viewport);

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
                viewport_rx.clone(),
                Arc::clone(&done),
            ))),
            Err(error) => {
                status(&size, &format!("error: {error}"));
                None
            }
        }
    };

    let header_task = tokio::spawn(header_loop(
        session.page().clone(),
        size_rx.clone(),
        viewport_rx,
        color_filter,
        named_session.then(|| session_name.to_string()),
        Arc::clone(&done),
    ));

    // The page the pane was opened on (a restored pane is handed the one it
    // was on). Read like `:goto`, so a bare host gets a scheme instead of a
    // navigation the engine never answers.
    if let Some(url) = goto {
        let url = verbs::normalise_url(&url);
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

    let code = read_loop(&mut session, size_rx, viewport_tx, attached).await;

    done.store(true, Ordering::Relaxed);
    header_task.abort();
    tag_pane(false);
    tag_url(None);
    resizes.abort();
    if let Some(drawer) = drawer {
        drawer.abort();
    }
    session.close().await;

    drop(raw);
    // The title goes back to tmux's own once the pane is a shell again.
    write_out(&format!(
        "\x1b]2;\x07{}{}{}",
        term::MOUSE_OFF,
        term::SHOW_CURSOR,
        term::ALT_SCREEN_OFF
    ));
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
    mut viewport: tokio::sync::watch::Receiver<Viewport>,
    done: Arc<AtomicBool>,
) {
    loop {
        if done.load(Ordering::Relaxed) {
            return;
        }
        let frame = frames.borrow_and_update().clone();
        let current = layout(*size.borrow_and_update(), *viewport.borrow_and_update());
        if !frame.is_empty() {
            let mut stdout = std::io::stdout().lock();
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
                changed = viewport.changed() => changed.is_err(),
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
    viewport: tokio::sync::watch::Sender<Viewport>,
    attached: bool,
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
                let current = *viewport.borrow();
                let page = layout(size, current);
                if let Err(error) = session
                    .set_viewport(page.page_w, page.page_h, current == Viewport::Mobile)
                    .await
                {
                    status(&size, &format!("error: {error}"));
                }
                continue;
            }
        };

        match input {
            Input::Key(key) if key.as_slice() == b"\x03" => return 0, // ctrl+c
            Input::Key(key) if key.as_slice() == b":" => {
                match command_mode(session, size, &viewport, &mut inputs).await {
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
                    let page = layout(size, *viewport.borrow());
                    forward_mouse(session, page, button, col, row, pressed).await;
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
    viewport: &tokio::sync::watch::Sender<Viewport>,
    inputs: &mut Inputs,
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
            b"\r" | b"\n" => return run_line(session, size, viewport, &line).await,
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
    viewport: &tokio::sync::watch::Sender<Viewport>,
    line: &str,
) -> CommandOutcome {
    if matches!(line.trim(), "q" | "quit" | "exit") {
        return CommandOutcome::Quit;
    }
    match verbs::parse(line) {
        // The pane's own verb: where the picture sits is this program's call.
        Ok(verbs::Verb::Viewport { viewport: next }) => {
            // No clear: the new picture covers the old one, and the image
            // parser retires a picture another is drawn over.
            viewport.send_replace(next);
            let page = layout(size, next);
            match session
                .set_viewport(page.page_w, page.page_h, next == Viewport::Mobile)
                .await
            {
                Ok(()) => status(&size, next.name()),
                Err(error) => status(&size, &format!("error: {error}")),
            }
        }
        Ok(verb) => match session.run(verb).await {
            Ok(output) => {
                let text = output.to_string();
                // One line: the status row is one line, and an agent reading it
                // back with `capture-pane` wants the answer, not a paragraph.
                let first = text.lines().next().unwrap_or("").to_string();
                status(&size, &first);
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
    let width = usize::from(size.cols);
    let shown: String = text.chars().take(width).collect();
    // Move to the status row, clear it, write, and leave the cursor there.
    write_out(&format!("\x1b[{};1H\x1b[2K{}", size.rows, shown));
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
fn key_name(key: &str) -> (String, Option<String>) {
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

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn the_picture_covers_everything_under_the_toolbar_row() {
        let size = PaneSize {
            cols: 80,
            rows: 24,
            cell_w: 8,
            cell_h: 16,
        };
        assert_eq!(
            size.image_rows(),
            23,
            "the toolbar row is the app's; the status row is under the picture"
        );
        assert_eq!(layout(size, Viewport::Auto).page_w, 640);
        assert_eq!(layout(size, Viewport::Auto).page_h, 368);
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
        assert!(layout(size, Viewport::Auto).page_h > 0);
        assert!(layout(size, Viewport::Mobile).rows > 0);
    }

    #[test]
    fn a_frame_is_drawn_home_so_it_replaces_the_last_one() {
        let size = PaneSize {
            cols: 10,
            rows: 5,
            cell_w: 8,
            cell_h: 16,
        };
        let drawn =
            String::from_utf8(draw_frame(b"\xff\xd8\xff", layout(size, Viewport::Auto))).unwrap();
        assert!(
            drawn.starts_with("\x1b[?25l\x1b[2;1H"),
            "the cursor must be at the picture's corner, or tmuxy anchors the picture somewhere new each time"
        );
        assert!(drawn.contains("width=10;height=4"), "{drawn}");
        assert!(drawn.ends_with('\x07'), "the OSC must be terminated");
        assert!(drawn.contains("inline=1"), "{drawn}");
        assert!(
            drawn.contains("preserveAspectRatio=0"),
            "a letterboxed picture puts clicks where the page is not: {drawn}"
        );
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
        // Row 2 is the picture's first: row 1 is the toolbar's.
        let page = layout(size, Viewport::Auto);
        assert_eq!(cell_to_page(1, 2, page), (4.0, 8.0));
        assert_eq!(cell_to_page(2, 4, page), (12.0, 40.0));
    }

    /// A fixed size keeps its own aspect: a phone page is a narrow column in
    /// the middle of a wide pane, and a click maps through that column only.
    #[test]
    fn a_fixed_viewport_is_drawn_at_its_own_aspect_and_clicked_through_it() {
        let size = PaneSize {
            cols: 160,
            rows: 41,
            cell_w: 8,
            cell_h: 16,
        };
        let phone = layout(size, Viewport::Mobile);
        assert_eq!((phone.page_w, phone.page_h), (400, 800));
        assert_eq!(phone.rows, 40, "as tall as the picture area");
        // 40 rows of 16px is 640px for 800px of page: 400px is 320px, 40 cells.
        assert_eq!(phone.cols, 40);
        assert_eq!(phone.col, 61, "centred: 60 columns of margin each side");
        assert!(!on_picture(60, 10, phone), "the margin is not the page");
        assert!(on_picture(61, 10, phone));
        // The middle of the column is the middle of the page.
        let (x, y) = cell_to_page(80, 21, phone);
        assert!(
            (x - 195.0).abs() < 10.0 && (y - 390.0).abs() < 20.0,
            "{x},{y}"
        );
        let drawn = String::from_utf8(draw_frame(b"\xff", phone)).unwrap();
        assert!(drawn.contains("\x1b[2;61H"), "{drawn}");
        assert!(drawn.contains("width=40;height=40"), "{drawn}");
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

    /// Wheel up scrolled the page DOWN: the sign was inverted against CDP,
    /// whose `deltaY` follows the DOM (positive = towards the bottom).
    #[test]
    fn wheel_up_scrolls_towards_the_top() {
        assert!(wheel_delta_y(true) < 0.0);
        assert!(wheel_delta_y(false) > 0.0);
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
        let argv = restore_tag_args(
            "%7",
            Some("notes"),
            true,
            Viewport::Mobile,
            Some("https://example.com/a b"),
        );
        assert_eq!(argv[0], "pane");
        assert_eq!(argv[1], "restore-cmd");
        assert_eq!(argv[3], "%7");
        assert_eq!(
            argv[2],
            "tmuxy browser --session 'notes' --color-filter --viewport mobile 'https://example.com/a b'"
        );
        let bare = restore_tag_args("%1", None, false, Viewport::Auto, None);
        assert_eq!(
            bare[2], "tmuxy browser",
            "a pane's own session is not carried over"
        );
    }

    /// The tag is what lets the app draw a toolbar over row 1; it is set and
    /// cleared through the CLI (`run-shell`), never by pane output.
    /// The address bar reads the page's address from its own tag; the CLI
    /// quotes it, so `&` and `#` in a URL stay one argument.
    #[test]
    fn the_address_is_tagged_and_untagged_through_the_cli() {
        assert_eq!(
            url_tag_args("%3", Some("https://example.com/?a=1&b#c")),
            [
                "run",
                "set-option",
                "-p",
                "-t",
                "%3",
                "@tmuxy-pane-url",
                "https://example.com/?a=1&b#c"
            ]
        );
        assert_eq!(
            url_tag_args("%3", None),
            [
                "run",
                "set-option",
                "-p",
                "-u",
                "-t",
                "%3",
                "@tmuxy-pane-url"
            ]
        );
    }

    #[test]
    fn the_live_tag_is_set_and_cleared_through_the_cli() {
        assert_eq!(
            widget_tag_args("%3", true),
            [
                "run",
                "set-option",
                "-p",
                "-t",
                "%3",
                "@tmuxy-pane-widget",
                "browser-live"
            ]
        );
        assert_eq!(
            widget_tag_args("%3", false),
            [
                "run",
                "set-option",
                "-p",
                "-u",
                "-t",
                "%3",
                "@tmuxy-pane-widget"
            ]
        );
    }

    /// The UI reads this row (`browserLiveHeader` in tmuxy-ui); the two must agree.
    #[test]
    fn the_toolbar_row_says_which_way_history_goes() {
        let nav = Navigation {
            url: "https://example.com/".into(),
            title: "Example Domain".into(),
            can_go_back: true,
            can_go_forward: false,
        };
        assert_eq!(
            header_line(&nav, false, Viewport::Auto),
            "tmuxy:browser 100a"
        );
        assert_eq!(
            header_line(&nav, true, Viewport::Mobile),
            "tmuxy:browser 101m"
        );
        assert!(
            header_line(&nav, true, Viewport::Desktop).len() < 20,
            "short enough never to wrap into the picture"
        );
    }

    /// A click on the toolbar row is the app's, not the page's; the status
    /// row is under the picture, so a click there is the page's.
    #[test]
    fn the_toolbar_row_takes_no_clicks_through_to_the_page() {
        let size = PaneSize {
            cols: 80,
            rows: 10,
            cell_w: 8,
            cell_h: 16,
        };
        let page = layout(size, Viewport::Auto);
        assert_eq!(size.image_rows(), 9);
        assert!(!on_picture(1, 1, page), "row 1 is the toolbar's");
        assert!(on_picture(1, 2, page));
        assert!(
            on_picture(80, 10, page),
            "the status row is under the picture"
        );
        assert!(
            !on_picture(81, 5, page),
            "past the last column is off the page"
        );
    }

    /// Every tab starts on `about:blank`; the first real page has nowhere to
    /// go back to.
    #[test]
    fn a_blank_start_is_not_somewhere_to_go_back_to() {
        assert!(!is_page("about:blank"));
        assert!(!is_page(""));
        assert!(is_page("https://example.com/"));
    }

    #[test]
    fn the_cell_size_override_is_read_as_wxh() {
        assert_eq!(parse_cell_px("9x18"), Some((9, 18)));
        assert_eq!(parse_cell_px("10X20"), Some((10, 20)));
        assert_eq!(parse_cell_px("nonsense"), None);
        assert_eq!(parse_cell_px(""), None);
    }
}
