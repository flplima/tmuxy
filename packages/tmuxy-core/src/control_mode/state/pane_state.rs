use super::*;
use crate::{extract_cells_from_screen, GroupId, PaneContent, PaneId, TmuxPane, WindowId};

pub struct PaneState {
    pub id: PaneId,

    /// tmux's `pane_index`.
    pub index: u32,

    /// Window this pane belongs to (e.g., "@0"); `None` until a layout or
    /// `list-panes` report places it.
    pub window_id: Option<WindowId>,

    /// Terminal emulator for this pane, with the title and clipboard requests
    /// it read. It, the image parser beside it, the scroll baseline and the
    /// content cache are the pane's own: they change together (`reset` in
    /// `pane_output.rs`), never from the aggregator.
    terminal: vt100::Parser<super::osc::OscRequests>,

    /// Last `vt100::Screen::scroll_delta` this pane observed: the difference
    /// to the current value is how far the grid moved, which keeps image
    /// placements on the lines they were drawn on. The counter belongs to one
    /// grid, so it MUST be re-based when the grid is replaced (a capture
    /// refresh, the alternate screen): a delta across grids shifts every
    /// placement off the screen.
    last_scroll_delta: i64,

    /// Which grid `last_scroll_delta` was read from: the alternate screen has
    /// its own counter and its own text.
    scroll_baseline_alt: bool,

    image_parser: super::images::ImageParser,

    /// Keyed by image id, served over HTTP.
    pub image_store: HashMap<u32, super::images::StoredImage>,
    /// Insertion order for `image_store`, so the cap evicts the oldest picture
    /// rather than an arbitrary one.
    pub(super) image_store_order: std::collections::VecDeque<u32>,

    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
    pub active: bool,
    pub command: String,
    pub title: String,

    /// The evaluated `pane-border-format`.
    pub border_title: String,

    /// Pane-group identity from `@tmuxy-group-id` (e.g. `g5`), or `None`.
    pub group_id: Option<GroupId>,
    /// `@tmuxy-group-pos`, when the group has been reordered.
    pub group_pos: Option<u32>,

    /// In copy mode
    pub in_mode: bool,

    /// In tmux's view mode — the pager a `run-shell -b` that prints, or
    /// `show-messages` from a terminal client, opens on the pane. The
    /// client draws no view mode, so the aggregator closes it as soon as a
    /// pane row reports it (`parse_list_panes_line`).
    pub view_mode: bool,

    pub copy_cursor_x: u32,
    pub copy_cursor_y: u32,

    /// Copy mode: lines scrolled back from the bottom.
    pub scroll_position: u32,

    /// The cursor tmux reports (authoritative).
    pub tmux_cursor_x: u32,
    pub tmux_cursor_y: u32,

    pub alternate_on: bool,
    pub mouse_any_flag: bool,

    /// tmux's marked pane (`select-pane -m`, `#{pane_marked}`). At most one
    /// pane per server carries it; `swap-pane`/`join-pane` without a source
    /// use it.
    pub marked: bool,

    pub selection_present: bool,
    pub selection_start_x: u32,

    /// Absolute history row, as tmux reports it.
    pub selection_start_y: u64,

    /// Lines scrolled off the top.
    pub history_size: u64,

    /// What the pane says it is doing (`@tmuxy-pane-state`), verbatim.
    /// Written by whatever runs in the pane — agent hooks, a shell's
    /// precmd/preexec, a build script — never inferred here.
    pub pane_state: Option<String>,

    /// The confirmation this pane is waiting on (`@tmuxy-ask`), verbatim: the
    /// base64 payload `tmuxy pane send -t` wrote. Decoded by the client, which draws the
    /// question over the pane; `None` when nothing is pending.
    pub pane_ask: Option<String>,
    /// `@tmuxy-pane-widget`: which widget this pane is AUTHORISED to render.
    /// See `tmux_options::PANE_WIDGET` — the marker in pane output is not
    /// enough on its own.
    pub pane_widget: Option<String>,
    /// `@tmuxy-pane-restore`: how the pane says it comes back after a restore.
    pub pane_restore: Option<String>,
    /// Bytes of `%output` this pane has had, for the trace's lifecycle events
    /// (`pane first output`): a pane that never gets any is the thing to see.
    pub output_bytes: u64,

    /// When this pane last had an OSC 52 write honoured; see
    /// `MIN_CLIPBOARD_INTERVAL`.
    pub last_clipboard_write: Option<Instant>,

    /// The copy-mode capture, kept apart from the live grid.
    pub copy_mode_content: Option<std::sync::Arc<PaneContent>>,

    /// Cursor shape set by DECSCUSR escape sequence
    /// 0=block, 1=block_blink, 2=block, 3=underline_blink, 4=underline, 5=bar_blink, 6=bar
    pub cursor_shape: u8,

    /// Whether the cursor is hidden (DECTCEM mode 25 off / ESC[?25l)
    pub cursor_hidden: bool,

    content_dirty: bool,

    /// `Arc`-shared with every snapshot that includes it, so handing it out is
    /// a refcount bump, not a per-cell deep copy.
    cached_content: Option<std::sync::Arc<PaneContent>>,
}

#[path = "pane_output.rs"]
mod output;

#[cfg(test)]
impl PaneState {
    pub(crate) fn screen(&self) -> &vt100::Screen {
        self.terminal.screen()
    }

    pub(crate) fn placements(&self) -> &[super::images::ImagePlacement] {
        &self.image_parser.placements
    }
}

impl PaneState {
    pub(super) fn set_title(&mut self, title: String) {
        self.title = shown_title(title);
    }

    pub fn in_window(&self, window: &WindowId) -> bool {
        self.window_id.as_ref() == Some(window)
    }

    pub fn new(id: PaneId, width: u32, height: u32) -> Self {
        // Guard: vt100 panics on zero dimensions
        let w = (width as u16).max(1);
        let h = (height as u16).max(1);
        Self {
            id,
            index: 0,
            window_id: None,
            terminal: vt100::Parser::new_with_callbacks(
                h,
                w,
                crate::constants::REFLOW_SCROLLBACK_ROWS,
                super::osc::OscRequests::default(),
            ),
            last_scroll_delta: 0,
            scroll_baseline_alt: false,
            image_parser: super::images::ImageParser::new(),
            image_store: HashMap::new(),
            image_store_order: std::collections::VecDeque::new(),
            x: 0,
            y: 0,
            width,
            height,
            active: false,
            command: String::new(),
            title: String::new(),
            border_title: String::new(),
            group_id: None,
            group_pos: None,
            in_mode: false,
            view_mode: false,
            copy_cursor_x: 0,
            copy_cursor_y: 0,
            scroll_position: 0,
            tmux_cursor_x: 0,
            tmux_cursor_y: 0,
            alternate_on: false,
            mouse_any_flag: false,
            marked: false,
            selection_present: false,
            selection_start_x: 0,
            selection_start_y: 0,
            history_size: 0,
            pane_state: None,
            pane_ask: None,
            pane_widget: None,
            pane_restore: None,
            output_bytes: 0,
            last_clipboard_write: None,
            copy_mode_content: None,
            cursor_shape: 0,
            cursor_hidden: false,
            content_dirty: true,
            cached_content: None,
        }
    }

    /// The pane's rows from `start` to `end` inclusive (row `0` is the top of
    /// the screen, negative rows are history), and the history depth. vt100
    /// exposes one screen-sized window onto its scrollback at a time, and
    /// asking for more history than exists clamps rather than fails, so the
    /// range is walked a screen at a time and the granted offset read back.
    #[cfg(test)]
    pub fn scrollback_cells(&mut self, start: i64, end: i64) -> (crate::PaneContent, usize) {
        let screen = self.terminal.screen_mut();
        let height = screen.size().0 as i64;
        let entered = screen.scrollback();

        // The deepest the grid will go, which is also the history depth.
        screen.set_scrollback(usize::MAX);
        let depth = screen.scrollback();

        let mut rows: crate::PaneContent = Vec::new();
        let mut want = start;
        while want <= end {
            let asked = if want < 0 {
                usize::try_from(want.unsigned_abs()).unwrap_or(usize::MAX)
            } else {
                0
            };
            let screen = self.terminal.screen_mut();
            screen.set_scrollback(asked);
            // What the grid granted, which is where this window really starts.
            let granted = screen.scrollback() as i64;
            let window = extract_cells_from_screen(self.terminal.screen());
            let first = -granted;
            for (i, line) in window.into_iter().enumerate() {
                let row = first + i as i64;
                if row >= want && row <= end {
                    rows.push(line);
                }
            }
            let next = first + height;
            if next <= want {
                // The grid could not go as deep as asked and cannot advance.
                break;
            }
            want = next;
        }

        self.terminal.screen_mut().set_scrollback(entered);
        (rows, depth)
    }

    pub fn get_content(&mut self) -> std::sync::Arc<PaneContent> {
        if !self.content_dirty {
            if let Some(ref cached) = self.cached_content {
                return std::sync::Arc::clone(cached);
            }
        }
        let content = std::sync::Arc::new(extract_cells_from_screen(self.terminal.screen()));
        self.cached_content = Some(std::sync::Arc::clone(&content));
        self.content_dirty = false;
        content
    }

    /// A copy-mode capture goes to a parser of its own: `%output` keeps
    /// arriving for the live grid while the pane is in copy mode.
    pub fn process_copy_mode_capture(&mut self, content: &[u8]) {
        let w = (self.width as u16).max(1);
        let h = (self.height as u16).max(1);
        let mut temp_terminal = vt100::Parser::new(h, w, 0);

        let normalized = normalize_capture_bytes(content);
        temp_terminal.process(&normalized);
        self.copy_mode_content = Some(std::sync::Arc::new(extract_cells_from_screen(
            temp_terminal.screen(),
        )));
    }

    /// `None` while the pane has no window yet: it is not part of any state.
    pub fn build_tmux_pane(&mut self) -> Option<TmuxPane> {
        let window_id = self.window_id.clone()?;
        // The emulator's cursor moves with every %output; tmux_cursor_x/y
        // only with a list-panes reply.
        let screen = self.terminal.screen();
        let vt100_cursor_x = screen.cursor_position().1 as u32;
        let vt100_cursor_y = screen.cursor_position().0 as u32;

        // The absolute selection row, made relative to the top of the view.
        let (sel_start_x, sel_start_y) = if self.selection_present {
            let view_start = self.history_size as i64 - self.scroll_position as i64;
            let visible_y = self.selection_start_y as i64 - view_start;
            (self.selection_start_x, visible_y as i32)
        } else {
            (0, 0)
        };

        Some(TmuxPane {
            id: self.index,
            tmux_id: self.id.clone(),
            window_id,
            content: if self.in_mode {
                self.copy_mode_content
                    .as_ref()
                    .cloned()
                    .unwrap_or_else(|| self.get_content())
            } else {
                self.get_content()
            },
            cursor_x: vt100_cursor_x,
            cursor_y: vt100_cursor_y,
            width: self.width,
            height: self.height,
            x: self.x,
            y: self.y,
            active: self.active,
            command: self.command.clone(),
            title: self.title.clone(),
            border_title: self.border_title.clone(),
            group_id: self.group_id.clone(),
            group_pos: self.group_pos,
            in_mode: self.in_mode,
            copy_cursor_x: self.copy_cursor_x,
            copy_cursor_y: self.copy_cursor_y,
            alternate_on: self.alternate_on,
            mouse_any_flag: self.mouse_any_flag,
            marked: self.marked,
            history_size: self.history_size,
            selection_present: self.selection_present,
            selection_start_x: sel_start_x,
            selection_start_y: sel_start_y,
            images: self.image_parser.placements.clone(),
            cursor_shape: self.cursor_shape,
            cursor_hidden: self.cursor_hidden,
            pane_state: self.pane_state.clone(),
            pane_ask: self.pane_ask.clone(),
            pane_widget: self.pane_widget.clone(),
            pane_restore: self.pane_restore.clone(),
        })
    }
}
