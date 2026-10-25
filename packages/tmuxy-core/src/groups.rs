//! Pane groups: the rules, once.
//!
//! A group is the set of panes carrying the same `@tmuxy-group-id` (`gN`).
//! One member is on screen, in a real session; the rest are parked one per
//! window in the stash session (`STASH_SESSION`), where no native `tmux
//! attach` sees them. Membership is a pane option, so it follows a pane across
//! the cross-session `swap-pane` that brings a member into view, and there is
//! no separate list to keep in sync. A group's ORDER is `@tmuxy-group-pos`
//! where a reorder wrote one, then pane number — see [`order_key`].
//!
//! Everything here is pure. An operation takes the panes as one
//! `list-panes -a` read ([`Panes`], parsed from [`LIST_PANES_FORMAT`]) and
//! returns the tmux commands that carry it out ([`Invocation`]s), so every rule
//! is a value a unit test can look at. `tmuxy-server group <verb>` does the
//! reading and the running (`group_cli.rs`), and the `packages/tmuxy-cli/bin/tmuxy/pane-group`
//! script is its name.

use std::fmt;

use crate::constants::{tmux_options, STASH_SESSION};
use crate::{GroupId, PaneId, WindowId};

/// What every group operation reads: one row per pane on the server, the
/// stash included. `session_name` is last because it is the one free-text
/// field: it may hold the separator, and the parser keeps everything after
/// the sixth one. The separator is a space, not a tab: tmux 3.4 prints a
/// control character in a format as `_`, and a row with no separators is no
/// row at all.
pub const LIST_PANES_FORMAT: &str = concat!(
    "#{pane_id} #{window_id} #{@tmuxy-group-id} #{@tmuxy-group-pos} ",
    "#{pane_width} #{pane_height} #{session_name}"
);

/// The field separator in [`LIST_PANES_FORMAT`].
const FIELD_SEPARATOR: char = ' ';

/// The program the stash session's own first window runs. The window exists
/// only so the session does; `tail -f /dev/null` sleeps in a read, where the
/// default interactive shell would open its controlling tty, and a shell
/// killed mid-`init_io` hangs in the kernel forever (see
/// `packages/tmuxy-cli/bin/tmuxy/reap-orphan-shells`).
pub const STASH_PAYLOAD: &str = "tail -f /dev/null";

/// One pane, as [`LIST_PANES_FORMAT`] prints it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PaneRow {
    pub pane: PaneId,
    pub window: WindowId,
    pub group: Option<GroupId>,
    pub pos: Option<u32>,
    pub width: u32,
    pub height: u32,
    pub session: String,
}

impl PaneRow {
    /// Parked out of view in the stash session.
    pub fn is_parked(&self) -> bool {
        self.session == STASH_SESSION
    }
}

/// Where a member sorts in its group: its `@tmuxy-group-pos` when a reorder
/// wrote one, then its pane number — the whole order of a group nobody has
/// rearranged. The frontend's `buildGroupsFromPanes` follows the same rule.
pub fn order_key(pos: Option<u32>, pane: &PaneId) -> (u32, u32) {
    (pos.unwrap_or(u32::MAX), pane.number())
}

/// Every pane on the server, read once.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Panes {
    rows: Vec<PaneRow>,
}

impl Panes {
    pub fn new(rows: Vec<PaneRow>) -> Self {
        Self { rows }
    }

    /// Parse a `list-panes -a -F LIST_PANES_FORMAT` read. A row that does not
    /// parse is not a pane this module can act on, and is left out.
    pub fn parse(output: &str) -> Self {
        let rows = output
            .lines()
            .filter_map(|line| {
                let mut f = line.splitn(7, FIELD_SEPARATOR);
                Some(PaneRow {
                    pane: PaneId::parse(f.next()?).ok()?,
                    window: WindowId::parse(f.next()?).ok()?,
                    group: GroupId::parse(f.next()?).ok(),
                    pos: f.next()?.parse().ok(),
                    width: f.next()?.parse().ok()?,
                    height: f.next()?.parse().ok()?,
                    session: f.next()?.to_string(),
                })
            })
            .collect();
        Self { rows }
    }

    pub fn row(&self, pane: &PaneId) -> Option<&PaneRow> {
        self.rows.iter().find(|r| r.pane == *pane)
    }

    pub fn group_of(&self, pane: &PaneId) -> Option<&GroupId> {
        self.row(pane)?.group.as_ref()
    }

    /// A group's members, in the group's order.
    pub fn members(&self, group: &GroupId) -> Vec<&PaneRow> {
        let mut members: Vec<&PaneRow> = self
            .rows
            .iter()
            .filter(|r| r.group.as_ref() == Some(group))
            .collect();
        members.sort_by_key(|r| order_key(r.pos, &r.pane));
        members
    }

    /// The member on screen: the one not parked in the stash.
    pub fn visible(&self, group: &GroupId) -> Option<&PaneRow> {
        self.rows
            .iter()
            .find(|r| r.group.as_ref() == Some(group) && !r.is_parked())
    }

    fn stash_exists(&self) -> bool {
        self.rows.iter().any(PaneRow::is_parked)
    }

    fn session_pane_count(&self, session: &str) -> usize {
        self.rows.iter().filter(|r| r.session == session).count()
    }

    /// Stash windows of groups with no member on screen any more — their tab
    /// was closed wholesale, orphaning the parked members.
    fn orphaned_stash_windows(&self) -> Vec<WindowId> {
        let mut windows: Vec<WindowId> = Vec::new();
        for r in self.rows.iter().filter(|r| r.is_parked()) {
            let Some(group) = &r.group else { continue };
            let shown = self.visible(group).is_some();
            if !shown && !windows.contains(&r.window) {
                windows.push(r.window.clone());
            }
        }
        windows
    }
}

/// One `tmux` process: its commands run as a single `;`-joined list, so they
/// land together. A `tolerant` invocation's failure is ignored — the
/// best-effort steps (unsetting an option that may not be set, sweeping a
/// window that may be gone).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Invocation {
    pub commands: Vec<Vec<String>>,
    pub tolerant: bool,
}

impl Invocation {
    fn strict(commands: Vec<Vec<String>>) -> Self {
        Self {
            commands,
            tolerant: false,
        }
    }

    fn tolerant(command: Vec<String>) -> Self {
        Self {
            commands: vec![command],
            tolerant: true,
        }
    }

    /// The argv after `tmux`: the commands with `;` between them.
    pub fn argv(&self) -> Vec<String> {
        let mut argv = Vec::new();
        for (i, command) in self.commands.iter().enumerate() {
            if i > 0 {
                argv.push(";".to_string());
            }
            argv.extend(command.iter().cloned());
        }
        argv
    }
}

fn cmd(parts: &[&str]) -> Vec<String> {
    parts.iter().map(|p| p.to_string()).collect()
}

/// What a group operation needs from outside the read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Context {
    /// The `pane-group close` command a member's `pane-died` hook runs.
    pub close_command: String,
    /// A value no earlier `@tmuxy-group-rev` had.
    pub rev_token: String,
}

/// Why an operation was refused. The text is what the script prints after its
/// own name.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GroupError {
    NoSuchPane(PaneId),
    NotInGroup(PaneId),
    JoinSelf,
    AlreadyGrouped(PaneId),
    LastPaneOfSession(PaneId),
    BadDirection(String),
}

impl fmt::Display for GroupError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NoSuchPane(p) => write!(f, "no pane {p}"),
            Self::NotInGroup(p) => write!(f, "{p} is not in a group"),
            Self::JoinSelf => write!(f, "a pane cannot join itself"),
            Self::AlreadyGrouped(p) => write!(f, "{p} is in a group already; leave it first"),
            Self::LastPaneOfSession(p) => write!(f, "{p} is the last pane of its session"),
            Self::BadDirection(_) => write!(f, "direction must be left, right, up or down"),
        }
    }
}

impl std::error::Error for GroupError {}

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

/// Create the stash session, detached, if it does not exist. `new-session -d`
/// is control-mode safe — unlike `new-window`, which crashes the server — and
/// the core suppresses the `%sessions-changed` it causes.
pub fn ensure_stash(panes: &Panes) -> Option<Invocation> {
    (!panes.stash_exists()).then(|| {
        Invocation::tolerant(cmd(&[
            "new-session",
            "-d",
            "-s",
            STASH_SESSION,
            "-n",
            "stash",
            "-x",
            "80",
            "-y",
            "24",
            STASH_PAYLOAD,
        ]))
    })
}

/// Kill the stash windows of orphaned groups. Idempotent; a group an
/// operation is working on is never one, since it has a member on screen.
pub fn gc(panes: &Panes) -> Vec<Invocation> {
    panes
        .orphaned_stash_windows()
        .iter()
        .map(|w| Invocation::tolerant(cmd(&["kill-window", "-t", w.as_str()])))
        .collect()
}

/// Make a member's pane outlive the program in it, and route its death back
/// through `pane-group close`.
///
/// Without this, a member that ends by ITSELF — `exit`, Ctrl+D, a crash — is
/// removed by tmux directly: the visible member's slot disappears, the parked
/// siblings are left with nothing on screen, and the whole group vanishes.
/// `remain-on-exit on` keeps a dead placeholder to swap a sibling into, and
/// the pane-scoped `pane-died` hook runs the same promotion the close button
/// does. Both are per pane and travel with it across the stash swap.
pub fn arm(pane: &PaneId, ctx: &Context) -> Vec<Invocation> {
    vec![
        Invocation::tolerant(cmd(&[
            "set-option",
            "-p",
            "-t",
            pane.as_str(),
            "remain-on-exit",
            "on",
        ])),
        Invocation::tolerant(cmd(&[
            "set-hook",
            "-p",
            "-t",
            pane.as_str(),
            "pane-died",
            &format!("run-shell \"bash {} {pane}\"", ctx.close_command),
        ])),
    ]
}

/// Undo [`arm`]: a pane out of every group closes like any other.
pub fn disarm(pane: &PaneId) -> Vec<Invocation> {
    vec![
        Invocation::tolerant(cmd(&[
            "set-option",
            "-pu",
            "-t",
            pane.as_str(),
            "remain-on-exit",
        ])),
        Invocation::tolerant(cmd(&["set-hook", "-pu", "-t", pane.as_str(), "pane-died"])),
    ]
}

/// Take a pane out of its group: its tag, its place and its arming.
pub fn ungroup(pane: &PaneId) -> Vec<Invocation> {
    let mut out = vec![Invocation::tolerant(cmd(&[
        "set-option",
        "-pu",
        "-t",
        pane.as_str(),
        tmux_options::GROUP_ID,
    ]))];
    out.extend(disarm(pane));
    out.push(Invocation::tolerant(cmd(&[
        "set-option",
        "-pu",
        "-t",
        pane.as_str(),
        tmux_options::GROUP_POS,
    ])));
    out
}

/// A group left with one member is no group: given the members that remain,
/// ungroup the survivor if there is just one.
pub fn dissolve_if_alone(remaining: &[PaneId]) -> Vec<Invocation> {
    match remaining {
        [survivor] => ungroup(survivor),
        _ => Vec::new(),
    }
}

/// Give each pane its place in the group, 0 onwards, in the order given, so
/// the order is a property of the panes and survives a restart through the
/// snapshot.
pub fn set_order(ordered: &[PaneId]) -> Invocation {
    Invocation::strict(
        ordered
            .iter()
            .enumerate()
            .map(|(i, p)| {
                cmd(&[
                    "set-option",
                    "-p",
                    "-t",
                    p.as_str(),
                    tmux_options::GROUP_POS,
                    &i.to_string(),
                ])
            })
            .collect(),
    )
}

/// Tell the backend a group changed in a way tmux does not announce (an
/// option written, a pane moved into the stash): every pane inherits the
/// global `@tmuxy-group-rev`, so a new value fires the monitor's pane-metadata
/// subscription and the panes are listed again.
pub fn bump_rev(ctx: &Context) -> Invocation {
    Invocation::strict(vec![cmd(&[
        "set-option",
        "-g",
        tmux_options::GROUP_REV,
        &ctx.rev_token,
    ])])
}

/// Move `pane` into the stash as a member of `group`, sized to the slot it
/// would show in. One list for the break and the tag, so the option is set by
/// the time the monitor sees the move.
fn park(pane: &PaneId, group: &GroupId, size: (u32, u32), ctx: &Context) -> Vec<Invocation> {
    let stash_target = format!("{STASH_SESSION}:");
    let mut out = vec![Invocation::strict(vec![
        cmd(&["break-pane", "-d", "-s", pane.as_str(), "-t", &stash_target]),
        cmd(&[
            "set-option",
            "-p",
            "-t",
            pane.as_str(),
            tmux_options::GROUP_ID,
            group.as_str(),
        ]),
    ])];
    out.extend(arm(pane, ctx));
    out.push(Invocation::strict(vec![resize_window(pane.as_str(), size)]));
    out
}

fn resize_window(target: &str, (width, height): (u32, u32)) -> Vec<String> {
    cmd(&[
        "resize-window",
        "-t",
        target,
        "-x",
        &width.to_string(),
        "-y",
        &height.to_string(),
    ])
}

/// Bring `target` into the slot `visible` holds: its stash window sized to the
/// slot first, then the swap.
fn swap_into_view(target: &PaneRow, visible: &PaneRow) -> Invocation {
    Invocation::strict(vec![
        resize_window(target.window.as_str(), (visible.width, visible.height)),
        cmd(&[
            "swap-pane",
            "-s",
            target.pane.as_str(),
            "-t",
            visible.pane.as_str(),
        ]),
    ])
}

fn split(anchor: &PaneId, cwd: Option<&str>) -> Vec<String> {
    let mut argv = cmd(&[
        "split-window",
        "-d",
        "-P",
        "-F",
        "#{pane_id}",
        "-t",
        anchor.as_str(),
    ]);
    if let Some(cwd) = cwd {
        argv.extend(cmd(&["-c", cwd]));
    }
    argv
}

/// `index` clamped into `0..=len`.
fn clamp_index(index: i64, len: usize) -> usize {
    usize::try_from(index.max(0)).unwrap_or(usize::MAX).min(len)
}

fn insert_at(mut others: Vec<PaneId>, index: i64, pane: PaneId) -> Vec<PaneId> {
    let at = clamp_index(index, others.len());
    others.insert(at, pane);
    others
}

fn ids(rows: &[&PaneRow]) -> Vec<PaneId> {
    rows.iter().map(|r| r.pane.clone()).collect()
}

mod ops;
pub use ops::*;

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests;
#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests_ops;
