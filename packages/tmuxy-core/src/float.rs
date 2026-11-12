//! The one tmux command list that makes a float: the split, the break-pane
//! that moves the new pane into a window of its own, every `@tmuxy-float-*`
//! tag, the size, the select-pane that gives the caller's pane back, and the
//! read of what was made. A plugin's float or popup surface
//! (`plugins::invoke::surface_argv`), `tmuxy pane float` (the server binary's
//! `float` verb, behind `bin/tmuxy/float-create`) and the MCP endpoint's
//! `pane_float` all build it here.
//!
//! One list is one command queue, so a client sees the split and the break in
//! the same batch of control-mode notifications and never renders the
//! intermediate state. Nothing in the list names the new pane, whose id does
//! not exist until split-window has run: `split-window` without `-d` makes the
//! new pane current for the commands that follow it (so an untargeted
//! break-pane moves that pane), and the new window's INDEX, named up front
//! ([`free_index`]), is how every command after the break reaches a window
//! whose id is not known yet.

use crate::constants::tmux_options;

/// A float's size when the caller names none, in terminal cells (never a
/// percentage: tmux sizes panes in cells, and so does the UI that draws the
/// float over them).
pub const DEFAULT_WIDTH: u32 = 60;
pub const DEFAULT_HEIGHT: u32 = 15;

/// The edge a drawer float slides in from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Drawer {
    Left,
    Right,
    Top,
    Bottom,
}

impl Drawer {
    pub const ALL: [Drawer; 4] = [Drawer::Left, Drawer::Right, Drawer::Top, Drawer::Bottom];

    /// The drawer [`Drawer::as_str`] names.
    pub fn parse(name: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|d| d.as_str() == name)
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Drawer::Left => "left",
            Drawer::Right => "right",
            Drawer::Top => "top",
            Drawer::Bottom => "bottom",
        }
    }

    /// A left or right drawer spans the full height and docks by its width;
    /// a top or bottom one the other way round.
    pub fn docks_by_width(self) -> bool {
        matches!(self, Drawer::Left | Drawer::Right)
    }
}

/// What is drawn behind a float.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Backdrop {
    Dim,
    Blur,
    None,
}

impl Backdrop {
    pub const ALL: [Backdrop; 3] = [Backdrop::Dim, Backdrop::Blur, Backdrop::None];

    /// The backdrop [`Backdrop::as_str`] names.
    pub fn parse(name: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|b| b.as_str() == name)
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Backdrop::Dim => "dim",
            Backdrop::Blur => "blur",
            Backdrop::None => "none",
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Float {
    /// The pane it is split from, and given back to: the caller's.
    pub from_pane: Option<String>,
    pub cwd: Option<String>,
    /// The new pane's command, as a shell line; a shell when absent.
    pub command: Option<String>,
    /// `session:index`: where the float's window goes ([`Spot::at`]).
    pub at: String,
    /// The tab it floats over.
    pub parent_window: Option<String>,
    /// In cells: the UI sizes the float by these tags.
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub drawer: Option<Drawer>,
    pub backdrop: Option<Backdrop>,
    pub no_header: bool,
}

impl Float {
    /// The command list (`;` as its own argument). It prints the new pane's
    /// id (the split's `-P`), then `<pane> <window>` from a read in the same
    /// list, while the float certainly exists: a command that exits at once
    /// closes it before the next tmux call.
    pub fn argv(&self) -> Vec<String> {
        let mut argv: Vec<String> = vec!["split-window".into()];
        if let Some(pane) = &self.from_pane {
            argv.extend(["-t".into(), pane.clone()]);
        }
        if let Some(cwd) = &self.cwd {
            argv.extend(["-c".into(), cwd.clone()]);
        }
        argv.extend(["-P".into(), "-F".into(), "#{pane_id}".into()]);
        argv.extend(self.command.clone());
        let at = self.at.as_str();
        let mut then = |cmd: &[&str]| {
            argv.push(";".into());
            argv.extend(cmd.iter().map(|s| s.to_string()));
        };
        let float = crate::WindowType::Float.as_str();
        then(&["break-pane", "-d", "-n", float, "-t", at]);
        let width = self.width.map(|w| w.to_string());
        let height = self.height.map(|h| h.to_string());
        let tags = [
            (tmux_options::WINDOW_TYPE, Some(float)),
            (tmux_options::FLOAT_PARENT, self.parent_window.as_deref()),
            (tmux_options::FLOAT_WIDTH, width.as_deref()),
            (tmux_options::FLOAT_HEIGHT, height.as_deref()),
            (tmux_options::FLOAT_DRAWER, self.drawer.map(Drawer::as_str)),
            (tmux_options::FLOAT_BG, self.backdrop.map(Backdrop::as_str)),
            (tmux_options::FLOAT_NOHEADER, self.no_header.then_some("1")),
        ];
        for (option, value) in tags {
            if let Some(value) = value {
                then(&["set-option", "-w", "-t", at, option, value]);
            }
        }
        // A single-pane window cannot be shrunk by resize-pane on every
        // backend, so the tags above are what the UI sizes the float by;
        // these keep the tmux-side pane in step where it can be resized.
        if let Some(width) = &width {
            then(&["resize-pane", "-t", at, "-x", width]);
        }
        if let Some(height) = &height {
            then(&["resize-pane", "-t", at, "-y", height]);
        }
        // break-pane takes the caller's ACTIVE pane away (split-window had to
        // make the new pane active for the break to find it), and tmux then
        // picks a survivor of its own choosing: hand the caller's pane back.
        if let Some(pane) = &self.from_pane {
            then(&["select-pane", "-t", pane]);
        }
        then(&["display-message", "-p", "-t", at, "#{pane_id} #{window_id}"]);
        argv
    }
}

/// The lowest window index not in use, scanning up from the lowest one (so a
/// `base-index 1` session never gets a stray window 0), from a
/// `list-windows -F '#{window_index}'`. break-pane picks a free index on its
/// own, but does not say which window it made, and a `set-option -w` with no
/// target resolves against the session's current window, which
/// `break-pane -d` leaves alone: naming the index up front is what lets the
/// whole float be one command list.
pub fn free_index(listing: &str) -> u32 {
    let used: std::collections::BTreeSet<u32> = listing
        .lines()
        .filter_map(|l| l.trim().parse().ok())
        .collect();
    let mut i = used.iter().next().copied().unwrap_or(0);
    while used.contains(&i) {
        i += 1;
    }
    i
}

/// Where a float from a pane goes: the pane's tab, which it floats over; that
/// tab's height in rows, which its default size fits ([`default_size`]); and
/// the lowest free window index in the pane's session ([`free_index`]), where
/// its window goes. Two reads make it, the second keyed by the session id the
/// first printed (an id, never a name, which tmux would match as a prefix):
/// [`Spot::pane_read`], then [`Spot::windows_read`] of what it printed, then
/// [`Spot::new`] of both. `tmuxy pane float` runs them as tmux calls, the MCP
/// endpoint over control mode.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Spot {
    pub window: String,
    pub session_id: String,
    pub rows: u32,
    pub free_index: u32,
}

impl Spot {
    /// The pane's id, tab, session and height; the session's current pane's
    /// when `pane` is `None`. Check [`Spot::answered_by`] before trusting it.
    pub fn pane_read(pane: Option<&str>) -> Vec<String> {
        let mut argv: Vec<String> = vec!["display-message".into(), "-p".into()];
        if let Some(pane) = pane {
            argv.extend(["-t".into(), pane.into()]);
        }
        argv.push("#{pane_id} #{window_id} #{session_id} #{window_height}".into());
        argv
    }

    /// Whether [`Spot::pane_read`]'s answer is `pane`'s own: tmux answers a
    /// closed pane's read for its default pane, or for none.
    pub fn answered_by(pane_out: &str, pane: &str) -> bool {
        pane_out.split_whitespace().next() == Some(pane)
    }

    /// The window indices of the session [`Spot::pane_read`] printed.
    pub fn windows_read(pane_out: &str) -> Vec<String> {
        let (_, session_id, _) = Self::facts(pane_out);
        vec![
            "list-windows".into(),
            "-t".into(),
            session_id.into(),
            "-F".into(),
            "#{window_index}".into(),
        ]
    }

    pub fn new(pane_out: &str, windows_out: &str) -> Self {
        let (window, session_id, rows) = Self::facts(pane_out);
        Spot {
            window: window.to_string(),
            session_id: session_id.to_string(),
            rows: rows.parse().unwrap_or(0),
            free_index: free_index(windows_out),
        }
    }

    /// [`Float::at`]: `session:index`.
    pub fn at(&self) -> String {
        format!("{}:{}", self.session_id, self.free_index)
    }

    fn facts(pane_out: &str) -> (&str, &str, &str) {
        let mut word = pane_out.split_whitespace().skip(1);
        let mut next = || word.next().unwrap_or_default();
        (next(), next(), next())
    }
}

/// The default height is never taller than the tab (`rows`, 0 when unknown):
/// a float with more rows than the window has nowhere to put them. An explicit
/// height is the caller's call.
pub fn default_size(
    width: Option<u32>,
    height: Option<u32>,
    drawer: Option<Drawer>,
    rows: u32,
) -> (Option<u32>, Option<u32>) {
    let default_height = if rows > 0 && rows < DEFAULT_HEIGHT {
        rows
    } else {
        DEFAULT_HEIGHT
    };
    match (width, height, drawer) {
        (None, None, None) => (Some(DEFAULT_WIDTH), Some(default_height)),
        (None, None, Some(d)) if d.docks_by_width() => (Some(DEFAULT_WIDTH), None),
        (None, None, Some(_)) => (None, Some(default_height)),
        (None, Some(h), Some(d)) if d.docks_by_width() => (Some(DEFAULT_WIDTH), Some(h)),
        (Some(w), None, Some(d)) if !d.docks_by_width() => (Some(w), Some(default_height)),
        (w, h, _) => (w, h),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_float_is_one_list_that_tags_sizes_and_gives_the_pane_back() {
        let float = Float {
            from_pane: Some("%3".into()),
            command: Some("fzf".into()),
            at: "$1:7".into(),
            parent_window: Some("@2".into()),
            width: Some(60),
            drawer: Some(Drawer::Left),
            backdrop: Some(Backdrop::Blur),
            ..Float::default()
        };
        assert_eq!(
            float.argv().join(" "),
            "split-window -t %3 -P -F #{pane_id} fzf \
             ; break-pane -d -n float -t $1:7 \
             ; set-option -w -t $1:7 @tmuxy-window-type float \
             ; set-option -w -t $1:7 @tmuxy-float-parent @2 \
             ; set-option -w -t $1:7 @tmuxy-float-width 60 \
             ; set-option -w -t $1:7 @tmuxy-float-drawer left \
             ; set-option -w -t $1:7 @tmuxy-float-bg blur \
             ; resize-pane -t $1:7 -x 60 \
             ; select-pane -t %3 \
             ; display-message -p -t $1:7 #{pane_id} #{window_id}"
        );
    }

    #[test]
    fn a_spot_is_keyed_by_the_session_id_the_pane_read_printed() {
        assert_eq!(
            Spot::pane_read(Some("%3")).join(" "),
            "display-message -p -t %3 #{pane_id} #{window_id} #{session_id} #{window_height}"
        );
        assert_eq!(
            Spot::pane_read(None).join(" "),
            "display-message -p #{pane_id} #{window_id} #{session_id} #{window_height}"
        );
        let printed = "%3 @2 $1 40\n";
        assert!(Spot::answered_by(printed, "%3"));
        // A closed pane's read, answered for another pane or for none.
        assert!(!Spot::answered_by("%0 @1 $0 24\n", "%3"));
        assert!(!Spot::answered_by("   \n", "%3"));
        assert_eq!(
            Spot::windows_read(printed).join(" "),
            "list-windows -t $1 -F #{window_index}"
        );
        let spot = Spot::new(printed, "1\n2\n4\n");
        assert_eq!(
            spot,
            Spot {
                window: "@2".into(),
                session_id: "$1".into(),
                rows: 40,
                free_index: 3,
            }
        );
        assert_eq!(spot.at(), "$1:3");
    }

    #[test]
    fn the_free_index_is_the_first_gap_from_the_lowest() {
        assert_eq!(free_index("1\n2\n4\n"), 3);
        assert_eq!(free_index("0\n"), 1);
        assert_eq!(free_index(""), 0);
    }

    #[test]
    fn a_float_takes_the_default_size_its_shape_docks_by() {
        assert_eq!(default_size(None, None, None, 40), (Some(60), Some(15)));
        // Never taller than the tab.
        assert_eq!(default_size(None, None, None, 10), (Some(60), Some(10)));
        assert_eq!(
            default_size(None, None, Some(Drawer::Left), 40),
            (Some(60), None)
        );
        assert_eq!(
            default_size(None, None, Some(Drawer::Top), 40),
            (None, Some(15))
        );
        assert_eq!(
            default_size(None, Some(30), Some(Drawer::Right), 40),
            (Some(60), Some(30))
        );
        assert_eq!(
            default_size(Some(90), None, Some(Drawer::Bottom), 8),
            (Some(90), Some(8))
        );
        // A size named for a centred float is the caller's, even half of one.
        assert_eq!(default_size(Some(90), None, None, 40), (Some(90), None));
        assert_eq!(default_size(None, Some(99), None, 40), (None, Some(99)));
    }
}
