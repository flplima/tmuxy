use super::*;
use crate::{
    extract_cells_from_screen, extract_cells_with_urls, GroupId, PaneContent, PaneId, TmuxPane,
    WindowId,
};

/// State of a single pane with terminal emulation
pub struct PaneState {
    /// Pane ID (e.g., "%0")
    pub id: PaneId,

    /// Pane index (tmux pane_index)
    pub index: u32,

    /// Window this pane belongs to (e.g., "@0"); `None` until a layout or
    /// `list-panes` report places it.
    pub window_id: Option<WindowId>,

    /// Terminal emulator for this pane
    pub terminal: vt100::Parser,

    /// OSC sequence parser for hyperlinks and clipboard
    pub osc_parser: super::osc::OscParser,

    /// Last `vt100::Screen::scroll_delta` this pane observed. The difference
    /// against the current value is how far the visible grid moved, which is
    /// what keeps the OSC 8 cell->URL marks on the lines they were written on.
    ///
    /// The counter belongs to one grid, so it MUST be re-based whenever the
    /// grid underneath it is replaced — a capture refresh builds a fresh
    /// parser, and the alternate screen is a different grid with its own
    /// counter. Comparing across either yields a nonsense delta that shifts
    /// every mark off the screen.
    pub(super) last_scroll_delta: i64,

    /// Which grid `last_scroll_delta` was read from: the alternate screen has
    /// its own counter and its own text.
    pub(super) scroll_baseline_alt: bool,

    /// Rows of vt100 history this pane keeps.
    ///
    /// `REFLOW_SCROLLBACK_ROWS` normally, which is only enough to survive a
    /// shrink-then-grow reflow. An OBSERVER's aggregator raises it to
    /// `VIEWER_SCROLLBACK_ROWS` so a viewer's scrollback request is answered
    /// from this grid instead of from tmux (see `scrollback_cells`).
    pub(super) scrollback_rows: usize,

    /// Image protocol parser (iTerm2, Sixel)
    pub image_parser: super::images::ImageParser,

    /// Stored images keyed by image ID (for HTTP retrieval)
    pub image_store: HashMap<u32, super::images::StoredImage>,
    /// Insertion order for `image_store`, so the cap evicts the oldest picture
    /// rather than an arbitrary one.
    pub(super) image_store_order: std::collections::VecDeque<u32>,

    /// Position in window (from layout)
    pub x: u32,
    pub y: u32,

    /// Dimensions
    pub width: u32,
    pub height: u32,

    /// Whether this pane is active
    pub active: bool,

    /// Running command
    pub command: String,

    /// Pane title (set by shell/application)
    pub title: String,

    /// Evaluated pane-border-format from tmux config
    pub border_title: String,

    /// Pane-group identity from `@tmuxy-group-id` (e.g. `g5`), or `None`.
    pub group_id: Option<GroupId>,
    /// `@tmuxy-group-pos`, when the group has been reordered.
    pub group_pos: Option<u32>,

    /// In copy mode
    pub in_mode: bool,

    /// Copy mode cursor position
    pub copy_cursor_x: u32,
    pub copy_cursor_y: u32,

    /// Copy mode scroll position (number of lines scrolled from bottom)
    pub scroll_position: u32,

    /// Tmux-reported cursor position (authoritative)
    pub tmux_cursor_x: u32,
    pub tmux_cursor_y: u32,

    /// Whether application is in alternate screen mode (vim, less, htop)
    pub alternate_on: bool,

    /// Whether application wants mouse events (mouse tracking enabled)
    pub mouse_any_flag: bool,

    /// tmux's marked pane (`select-pane -m`, `#{pane_marked}`). At most one
    /// pane per server carries it; `swap-pane`/`join-pane` without a source
    /// use it.
    pub marked: bool,

    /// Whether this pane's output is paused due to flow control
    pub paused: bool,

    /// Whether a selection is active in copy mode
    pub selection_present: bool,

    /// Selection start X (column) - absolute, from tmux
    pub selection_start_x: u32,

    /// Selection start Y (row) - absolute history coordinate
    pub selection_start_y: u64,

    /// History size (number of lines scrolled off the top)
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

    /// Content captured during copy mode (separate from main terminal to avoid corruption)
    pub copy_mode_content: Option<std::sync::Arc<PaneContent>>,

    /// Cursor shape set by DECSCUSR escape sequence
    /// 0=block, 1=block_blink, 2=block, 3=underline_blink, 4=underline, 5=bar_blink, 6=bar
    pub cursor_shape: u8,

    /// Whether the cursor is hidden (DECTCEM mode 25 off / ESC[?25l)
    pub cursor_hidden: bool,

    /// Whether terminal content has changed since last extraction
    pub(super) content_dirty: bool,

    /// Cached extracted content (avoids re-extracting when content hasn't changed).
    /// `Arc`-shared with every snapshot that includes it, so handing it out is a
    /// refcount bump, not a per-cell deep copy.
    pub(super) cached_content: Option<std::sync::Arc<PaneContent>>,
}

impl PaneState {
    /// Whether the pane currently sits in `window`.
    pub fn in_window(&self, window: &WindowId) -> bool {
        self.window_id.as_ref() == Some(window)
    }

    pub fn new(id: PaneId, width: u32, height: u32) -> Self {
        // Guard: vt100 panics on zero dimensions
        let w = (width as u16).max(1);
        let h = (height as u16).max(1);
        let mut osc_parser = super::osc::OscParser::new();
        osc_parser.set_viewport_height(height);
        Self {
            id,
            index: 0,
            window_id: None,
            terminal: vt100::Parser::new(h, w, crate::constants::REFLOW_SCROLLBACK_ROWS),
            scrollback_rows: crate::constants::REFLOW_SCROLLBACK_ROWS,
            osc_parser,
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
            copy_cursor_x: 0,
            copy_cursor_y: 0,
            scroll_position: 0,
            tmux_cursor_x: 0,
            tmux_cursor_y: 0,
            alternate_on: false,
            mouse_any_flag: false,
            marked: false,
            paused: false,
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

    /// Keep `rows` of history in this pane's grid instead of the reflow
    /// minimum. Called at creation, before any output has been fed, because
    /// vt100 fixes the scrollback capacity when the grid is built.
    pub(super) fn with_scrollback_rows(mut self, rows: usize) -> Self {
        // A writer's panes ask for the capacity they already have, and every
        // pane goes through here: rebuilding unconditionally threw away a
        // freshly built vt100 grid per pane for nothing, which `full_sync`
        // measured.
        if rows == self.scrollback_rows {
            return self;
        }
        self.scrollback_rows = rows;
        self.terminal = self.fresh_terminal();
        self
    }

    /// The pane's history as rendered rows, from `start` to `end` inclusive,
    /// where row `0` is the top of the screen and negative rows are history.
    ///
    /// Answers the viewer scrollback request from this grid, at zero tmux
    /// round trips. vt100 only ever exposes one screen-sized window onto its
    /// scrollback, so the range is walked a screen at a time and the offset
    /// tmux actually granted is read back each time — asking for more history
    /// than exists clamps rather than fails, and the clamped value is what
    /// says which row the window starts on.
    ///
    /// Returns the rows and the history depth (how many rows sit above the
    /// screen), or `None` if the grid holds no such pane.
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
            let asked = if want < 0 { (-want) as usize } else { 0 };
            let screen = self.terminal.screen_mut();
            screen.set_scrollback(asked);
            // What the grid granted, which is where this window really starts.
            let granted = screen.scrollback() as i64;
            let window = extract_cells_with_urls(self.terminal.screen(), None);
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

    /// Get the rendered screen content as structured cells.
    /// Uses cached content when terminal hasn't changed since last extraction.
    /// Returns an `Arc` so a clean cache hit is a refcount bump — repeated
    /// state builds between output events share one extraction.
    pub fn get_content(&mut self) -> std::sync::Arc<PaneContent> {
        if !self.content_dirty {
            if let Some(ref cached) = self.cached_content {
                return std::sync::Arc::clone(cached);
            }
        }
        let content = std::sync::Arc::new(extract_cells_with_urls(
            self.terminal.screen(),
            Some(&self.osc_parser),
        ));
        self.cached_content = Some(std::sync::Arc::clone(&content));
        self.content_dirty = false;
        content
    }

    /// Process capture-pane output during copy mode.
    /// Uses a temporary terminal to avoid corrupting the main terminal state,
    /// since %output events from background processes continue arriving during copy mode.
    pub fn process_copy_mode_capture(&mut self, content: &[u8]) {
        let w = (self.width as u16).max(1);
        let h = (self.height as u16).max(1);
        let mut temp_terminal = vt100::Parser::new(h, w, 0);

        let normalized = normalize_capture_bytes(content);
        safe_process(&mut temp_terminal, &normalized);
        self.copy_mode_content = Some(std::sync::Arc::new(extract_cells_from_screen(
            temp_terminal.screen(),
        )));
    }

    /// Build TmuxPane struct (uses &mut self for content caching). `None`
    /// while the pane has no window yet: it is not part of any state.
    pub fn build_tmux_pane(&mut self) -> Option<TmuxPane> {
        let window_id = self.window_id.clone()?;
        // Use vt100 emulator cursor for immediate feedback on output events.
        // The vt100 cursor is updated on every %output event, while tmux_cursor_x/y
        // are only updated on periodic list-panes responses (every 500ms).
        let screen = self.terminal.screen();
        let vt100_cursor_x = screen.cursor_position().1 as u32;
        let vt100_cursor_y = screen.cursor_position().0 as u32;

        // Convert absolute selection start Y to visible-area-relative coordinate
        // history_size = lines above the visible area
        // scroll_position = lines scrolled back from the bottom
        // view_start = history_size - scroll_position (absolute line at top of visible area)
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
            paused: self.paused,
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
