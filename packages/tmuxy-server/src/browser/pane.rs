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

use std::io::Write;
use std::os::fd::AsRawFd;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use super::session::{Attachment, Output, Session};
use super::verbs::{self, Viewport};

mod input;
mod ui;
pub use input::{forward_key, forward_mouse, Input};
use input::{read_loop, RawMode};
pub use ui::LIVE_WIDGET;
use ui::{header, header_loop, status, tag_pane, tag_url, write_out, Navigation, ReplLog};

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests;

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
    // The REPL view: the verb log drawn in the pane instead of the picture,
    // for the person who wants to see what an agent (or they) typed and what
    // came back. Off to begin with — the picture is what a browser pane is
    // for — and flipped by `:repl` or the toolbar's button.
    let (repl_tx, repl_rx) = tokio::sync::watch::channel(false);
    let log = ReplLog::default();
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
    let _ = write!(
        stdout,
        "{}{}{}{}",
        term::ALT_SCREEN_ON,
        term::CLEAR,
        term::MOUSE_ON,
        term::HIDE_CURSOR
    );
    let _ = stdout.flush();

    let raw = RawMode::enter().ok();
    tag_pane(true);
    header(&size, &Navigation::default(), color_filter, viewport, false);

    let banner = if attached {
        format!("tmuxy browser [{session_name}] — attached to your browser; `:` for verbs, ctrl+c to leave")
    } else {
        format!("tmuxy browser [{session_name}] — `:` for verbs, ctrl+c to leave")
    };
    log.push(&banner);
    status(&size, &banner);

    // The frame drawer. An attached session is drawn too: the picture is what
    // the pane is for, and whoever is looking at the real window can look at
    // either.
    let done = Arc::new(AtomicBool::new(false));
    let drawer = match session.start_frames().await {
        Ok(frames) => Some(tokio::spawn(draw_loop(
            frames,
            size_rx.clone(),
            viewport_rx.clone(),
            repl_rx.clone(),
            Arc::clone(&done),
        ))),
        Err(error) => {
            status(&size, &format!("error: {error}"));
            None
        }
    };

    let header_task = tokio::spawn(header_loop(
        session.page().clone(),
        size_rx.clone(),
        viewport_rx,
        repl_rx,
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

    let code = read_loop(&mut session, size_rx, viewport_tx, repl_tx, log).await;

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
    mut repl: tokio::sync::watch::Receiver<bool>,
    done: Arc<AtomicBool>,
) {
    loop {
        if done.load(Ordering::Relaxed) {
            return;
        }
        let frame = frames.borrow_and_update().clone();
        let current = layout(*size.borrow_and_update(), *viewport.borrow_and_update());
        // While the REPL view is up the pane is text: the frame is kept, not
        // drawn, and drawn at once when the picture comes back.
        let showing_repl = *repl.borrow_and_update();
        if !frame.is_empty() && !showing_repl {
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
                changed = repl.changed() => changed.is_err(),
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
