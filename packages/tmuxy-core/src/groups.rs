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
//! reading and the running (`group_cli.rs`), and the `bin/tmuxy/pane-group-*`
//! scripts are its names.

use std::fmt;

use crate::constants::{tmux_options, STASH_SESSION};
use crate::{GroupId, PaneId, WindowId};

/// What every group operation reads: one row per pane on the server, the
/// stash included. `session_name` is last because it is the one free-text
/// field.
pub const LIST_PANES_FORMAT: &str = concat!(
    "#{pane_id}\t#{window_id}\t#{@tmuxy-group-id}\t#{@tmuxy-group-pos}\t",
    "#{pane_width}\t#{pane_height}\t#{session_name}"
);

/// The program the stash session's own first window runs. The window exists
/// only so the session does; `tail -f /dev/null` sleeps in a read, where the
/// default interactive shell would open its controlling tty, and a shell
/// killed mid-`init_io` hangs in the kernel forever (see
/// `bin/tmuxy/reap-orphan-shells`).
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
                let mut f = line.splitn(7, '\t');
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
    /// The `pane-group-close` script a member's `pane-died` hook runs.
    pub close_script: String,
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
/// through `pane-group-close`.
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
            &format!("run-shell \"bash {} {pane}\"", ctx.close_script),
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

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

/// The first half of a two-step operation: what runs before the split, the
/// split itself (it prints the new pane's id), and the group the new pane
/// joins.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SplitPlan {
    pub before: Vec<Invocation>,
    pub split: Vec<String>,
    pub group: GroupId,
}

/// `add`: a new pane in `anchor`'s group, shown in its place. An ungrouped
/// anchor opens a group named after it, and is armed like every member.
/// Orphans an earlier wholesale tab-kill left in the stash are swept first,
/// which bounds the stash without a separate trigger.
pub fn add(panes: &Panes, anchor: &PaneId, ctx: &Context) -> Result<SplitPlan, GroupError> {
    panes
        .row(anchor)
        .ok_or_else(|| GroupError::NoSuchPane(anchor.clone()))?;
    let mut before: Vec<Invocation> = ensure_stash(panes).into_iter().collect();
    before.extend(gc(panes));
    let group = match panes.group_of(anchor) {
        Some(group) => group.clone(),
        None => {
            let group = GroupId::from_anchor(anchor);
            before.push(Invocation::strict(vec![cmd(&[
                "set-option",
                "-p",
                "-t",
                anchor.as_str(),
                tmux_options::GROUP_ID,
                group.as_str(),
            ])]));
            before.extend(arm(anchor, ctx));
            group
        }
    };
    Ok(SplitPlan {
        before,
        split: split(anchor, None),
        group,
    })
}

/// `add`, once the split has printed `new`: park it in the group at the
/// slot's size, then swap it into view.
pub fn add_finish(
    anchor: &PaneId,
    group: &GroupId,
    new: &PaneId,
    size: (u32, u32),
    ctx: &Context,
) -> Vec<Invocation> {
    let mut out = park(new, group, size, ctx);
    out.push(Invocation::strict(vec![cmd(&[
        "swap-pane",
        "-s",
        new.as_str(),
        "-t",
        anchor.as_str(),
    ])]));
    out
}

/// `park`: a new pane in `group`, parked out of view beside `anchor` (a
/// session restore bringing back the members a snapshot found in the stash).
/// The anchor is a member too, armed like `add` arms it.
pub fn park_split(
    panes: &Panes,
    anchor: &PaneId,
    group: &GroupId,
    cwd: &str,
    ctx: &Context,
) -> Result<SplitPlan, GroupError> {
    panes
        .row(anchor)
        .ok_or_else(|| GroupError::NoSuchPane(anchor.clone()))?;
    let mut before: Vec<Invocation> = ensure_stash(panes).into_iter().collect();
    before.extend(arm(anchor, ctx));
    Ok(SplitPlan {
        before,
        split: split(anchor, Some(cwd)),
        group: group.clone(),
    })
}

/// `park`, once the split has printed `new`.
pub fn park_finish(
    panes: &Panes,
    anchor: &PaneId,
    group: &GroupId,
    new: &PaneId,
    pos: Option<u32>,
    ctx: &Context,
) -> Vec<Invocation> {
    let size = panes.row(anchor).map_or((80, 24), |r| (r.width, r.height));
    let mut out = park(new, group, size, ctx);
    if let Some(pos) = pos {
        out.insert(
            out.len() - 1,
            Invocation::strict(vec![cmd(&[
                "set-option",
                "-p",
                "-t",
                new.as_str(),
                tmux_options::GROUP_POS,
                &pos.to_string(),
            ])]),
        );
    }
    out
}

/// `close`: the visible member hands its slot to the next member before it
/// goes; a parked one goes with its stash window; a pane in no group is just
/// killed. A group left with one member is dissolved.
pub fn close(panes: &Panes, pane: &PaneId) -> Result<Vec<Invocation>, GroupError> {
    let row = panes
        .row(pane)
        .ok_or_else(|| GroupError::NoSuchPane(pane.clone()))?;
    let Some(group) = &row.group else {
        return Ok(vec![Invocation::strict(vec![cmd(&[
            "kill-pane",
            "-t",
            pane.as_str(),
        ])])]);
    };
    let members = panes.members(group);
    let mut out = Vec::new();
    let next = members.iter().find(|m| m.pane != *pane);
    match next {
        Some(next) if !row.is_parked() => {
            // The sibling comes into view, and the window it leaves behind —
            // which now holds the closing pane — goes.
            out.push(Invocation::strict(vec![
                cmd(&["swap-pane", "-s", pane.as_str(), "-t", next.pane.as_str()]),
                cmd(&["kill-window", "-t", next.window.as_str()]),
            ]));
        }
        _ if row.is_parked() => {
            out.push(Invocation::strict(vec![cmd(&[
                "kill-window",
                "-t",
                row.window.as_str(),
            ])]));
        }
        _ => {
            out.push(Invocation::strict(vec![cmd(&[
                "kill-pane",
                "-t",
                pane.as_str(),
            ])]));
        }
    }
    let remaining: Vec<PaneId> = members
        .iter()
        .filter(|m| m.pane != *pane)
        .map(|m| m.pane.clone())
        .collect();
    out.extend(dissolve_if_alone(&remaining));
    out.extend(gc(panes));
    Ok(out)
}

/// `switch`: bring `target` into view in its group. Nothing when it is not a
/// member, or already the one on screen.
pub fn switch(panes: &Panes, target: &PaneId) -> Vec<Invocation> {
    let Some(target) = panes.row(target) else {
        return Vec::new();
    };
    let Some(group) = &target.group else {
        return Vec::new();
    };
    match panes.visible(group) {
        Some(visible) if visible.pane != target.pane => vec![swap_into_view(target, visible)],
        _ => Vec::new(),
    }
}

/// Which way `step` goes through the group's order.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Direction {
    Next,
    Prev,
}

/// `next` / `prev`: show the member after (or before) the one on screen,
/// wrapping. `pane` names the group.
pub fn step(panes: &Panes, pane: &PaneId, direction: Direction) -> Vec<Invocation> {
    let Some(group) = panes.group_of(pane) else {
        return Vec::new();
    };
    let members = panes.members(group);
    let Some(visible) = panes.visible(group) else {
        return Vec::new();
    };
    let Some(at) = members.iter().position(|m| m.pane == visible.pane) else {
        return Vec::new();
    };
    if members.len() < 2 {
        return Vec::new();
    }
    let target = match direction {
        Direction::Next => (at + 1) % members.len(),
        Direction::Prev => (at + members.len() - 1) % members.len(),
    };
    switch(panes, &members[target].pane)
}

/// `move`: put a member at `index` in its group's order (past the end means
/// last). Every member's place is written.
pub fn move_to(
    panes: &Panes,
    pane: &PaneId,
    index: i64,
    ctx: &Context,
) -> Result<Vec<Invocation>, GroupError> {
    let group = panes
        .group_of(pane)
        .ok_or_else(|| GroupError::NotInGroup(pane.clone()))?;
    let others: Vec<PaneId> = panes
        .members(group)
        .iter()
        .filter(|m| m.pane != *pane)
        .map(|m| m.pane.clone())
        .collect();
    let ordered = insert_at(others, index, pane.clone());
    Ok(vec![set_order(&ordered), bump_rev(ctx)])
}

/// `join`: make an ungrouped `pane` a member of `anchor`'s group (an
/// ungrouped anchor opens one), parked out of view at `index` in the order
/// (last when `None`). The window `pane` leaves re-tiles, or closes if it was
/// the window's only pane.
pub fn join(
    panes: &Panes,
    pane: &PaneId,
    anchor: &PaneId,
    index: Option<i64>,
    ctx: &Context,
) -> Result<Vec<Invocation>, GroupError> {
    if pane == anchor {
        return Err(GroupError::JoinSelf);
    }
    let row = panes
        .row(pane)
        .ok_or_else(|| GroupError::NoSuchPane(pane.clone()))?;
    let anchor_row = panes
        .row(anchor)
        .ok_or_else(|| GroupError::NoSuchPane(anchor.clone()))?;
    if row.group.is_some() {
        return Err(GroupError::AlreadyGrouped(pane.clone()));
    }
    if panes.session_pane_count(&row.session) <= 1 {
        return Err(GroupError::LastPaneOfSession(pane.clone()));
    }
    let mut out: Vec<Invocation> = ensure_stash(panes).into_iter().collect();
    let (group, members, visible) = match &anchor_row.group {
        Some(group) => (
            group.clone(),
            ids(&panes.members(group)),
            panes.visible(group).unwrap_or(anchor_row),
        ),
        None => {
            let group = GroupId::from_anchor(anchor);
            out.push(Invocation::strict(vec![cmd(&[
                "set-option",
                "-p",
                "-t",
                anchor.as_str(),
                tmux_options::GROUP_ID,
                group.as_str(),
            ])]));
            out.extend(arm(anchor, ctx));
            (group, vec![anchor.clone()], anchor_row)
        }
    };
    let index = index.unwrap_or(members.len() as i64);
    out.extend(park(pane, &group, (visible.width, visible.height), ctx));
    out.push(set_order(&insert_at(members, index, pane.clone())));
    out.push(bump_rev(ctx));
    Ok(out)
}

/// Where a member that leaves its group goes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Leave {
    /// A tab of its own, shown.
    Tab,
    /// Split in beside `target`, on `side`.
    Beside { target: PaneId, side: Side },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Side {
    Left,
    Right,
    Up,
    Down,
}

impl Side {
    /// `left` / `right` / `up` / `down`; empty means `right`.
    pub fn parse(word: &str) -> Result<Self, GroupError> {
        match word {
            "left" => Ok(Self::Left),
            "right" | "" => Ok(Self::Right),
            "up" => Ok(Self::Up),
            "down" => Ok(Self::Down),
            other => Err(GroupError::BadDirection(other.to_string())),
        }
    }

    fn join_flags(self) -> &'static [&'static str] {
        match self {
            Self::Left => &["-h", "-b"],
            Self::Right => &["-h"],
            Self::Up => &["-v", "-b"],
            Self::Down => &["-v"],
        }
    }
}

/// `leave`: take a member out of its group. A member on screen first hands
/// its place to the next member in the order (or the one before, if it was
/// last), so the group keeps showing something; a group left with one member
/// is no group.
pub fn leave(
    panes: &Panes,
    pane: &PaneId,
    to: &Leave,
    ctx: &Context,
) -> Result<Vec<Invocation>, GroupError> {
    let row = panes
        .row(pane)
        .ok_or_else(|| GroupError::NoSuchPane(pane.clone()))?;
    let group = row
        .group
        .as_ref()
        .ok_or_else(|| GroupError::NotInGroup(pane.clone()))?;
    let members = panes.members(group);
    let mut out = Vec::new();

    // Where the pane is once the group shows another member: the slot owner
    // swaps with its successor, which leaves the pane in the successor's
    // stash window.
    let visible = panes.visible(group).unwrap_or(row);
    let mut window = row.window.clone();
    if visible.pane == *pane {
        let at = members.iter().position(|m| m.pane == *pane).unwrap_or(0);
        let successor = members
            .get(at + 1)
            .or_else(|| at.checked_sub(1).and_then(|i| members.get(i)));
        if let Some(successor) = successor {
            out.push(swap_into_view(successor, row));
            window = successor.window.clone();
        }
    }

    out.extend(ungroup(pane));
    match to {
        Leave::Beside { target, side } => {
            let mut argv = cmd(&["join-pane"]);
            argv.extend(cmd(side.join_flags()));
            argv.extend(cmd(&["-s", pane.as_str(), "-t", target.as_str()]));
            out.push(Invocation::strict(vec![argv]));
        }
        Leave::Tab => {
            let session_target = format!("{}:", visible.session);
            out.push(Invocation::strict(vec![
                cmd(&["move-window", "-s", window.as_str(), "-t", &session_target]),
                cmd(&["select-window", "-t", window.as_str()]),
            ]));
        }
    }

    let remaining: Vec<PaneId> = members
        .iter()
        .filter(|m| m.pane != *pane)
        .map(|m| m.pane.clone())
        .collect();
    if remaining.len() > 1 {
        out.push(set_order(&remaining));
    } else {
        out.extend(dissolve_if_alone(&remaining));
    }
    out.push(bump_rev(ctx));
    Ok(out)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;
    use crate::ids::test_ids::{gid, pid, wid};

    fn ctx() -> Context {
        Context {
            close_script: "/s/pane-group-close".to_string(),
            rev_token: "T".to_string(),
        }
    }

    fn row(pane: &str, window: &str, group: &str, pos: Option<u32>, session: &str) -> PaneRow {
        PaneRow {
            pane: pid(pane),
            window: wid(window),
            group: GroupId::parse(group).ok(),
            pos,
            width: 80,
            height: 24,
            session: session.to_string(),
        }
    }

    /// Every command line, one per element, as `tmux` would be handed them.
    fn lines(plan: &[Invocation]) -> Vec<String> {
        plan.iter()
            .flat_map(|i| i.commands.iter().map(|c| c.join(" ")))
            .collect()
    }

    /// `work` shows `%1` (group g1, with `%4` and `%7` parked) beside `%2`;
    /// the stash's own first window is `%0`.
    fn grouped() -> Panes {
        Panes::new(vec![
            row("%0", "@0", "", None, STASH_SESSION),
            row("%1", "@1", "g1", None, "work"),
            row("%2", "@1", "", None, "work"),
            row("%4", "@4", "g1", None, STASH_SESSION),
            row("%7", "@7", "g1", None, STASH_SESSION),
        ])
    }

    #[test]
    fn a_read_parses_into_rows() {
        let panes = Panes::parse(
            "%1\t@1\tg1\t2\t80\t24\twork\n%2\t@1\t\t\t40\t12\tmy session\nnot a row\n",
        );
        assert_eq!(panes.rows.len(), 2);
        assert_eq!(panes.rows[0].group, Some(gid("g1")));
        assert_eq!(panes.rows[0].pos, Some(2));
        assert_eq!(panes.rows[1].group, None);
        assert_eq!(panes.rows[1].session, "my session");
        assert_eq!((panes.rows[1].width, panes.rows[1].height), (40, 12));
    }

    #[test]
    fn order_is_by_position_then_pane_number() {
        let panes = Panes::new(vec![
            row("%10", "@1", "g1", None, "work"),
            row("%9", "@2", "g1", None, STASH_SESSION),
            row("%3", "@3", "g1", Some(1), STASH_SESSION),
            row("%12", "@4", "g1", Some(0), STASH_SESSION),
        ]);
        let order: Vec<String> = panes
            .members(&gid("g1"))
            .iter()
            .map(|r| r.pane.to_string())
            .collect();
        assert_eq!(order, ["%12", "%3", "%9", "%10"]);
    }

    #[test]
    fn the_visible_member_is_the_one_not_parked() {
        assert_eq!(grouped().visible(&gid("g1")).unwrap().pane, "%1");
    }

    #[test]
    fn invocations_join_their_commands_with_a_semicolon() {
        let inv = Invocation::strict(vec![cmd(&["a", "1"]), cmd(&["b"])]);
        assert_eq!(inv.argv(), ["a", "1", ";", "b"]);
    }

    #[test]
    fn the_stash_is_created_only_when_missing() {
        assert!(ensure_stash(&grouped()).is_none());
        let fresh = Panes::new(vec![row("%1", "@1", "", None, "work")]);
        let inv = ensure_stash(&fresh).unwrap();
        assert!(inv.tolerant);
        assert_eq!(
            inv.commands[0],
            cmd(&[
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
                STASH_PAYLOAD
            ])
        );
    }

    #[test]
    fn gc_sweeps_only_groups_with_nothing_on_screen() {
        let mut rows = grouped().rows;
        rows.push(row("%8", "@8", "g5", None, STASH_SESSION));
        rows.push(row("%9", "@9", "g5", None, STASH_SESSION));
        let plan = gc(&Panes::new(rows));
        assert_eq!(lines(&plan), ["kill-window -t @8", "kill-window -t @9"]);
        assert!(plan.iter().all(|i| i.tolerant));
    }

    #[test]
    fn arming_holds_the_pane_open_and_hooks_its_death_to_close() {
        assert_eq!(
            lines(&arm(&pid("%4"), &ctx())),
            [
                "set-option -p -t %4 remain-on-exit on",
                "set-hook -p -t %4 pane-died run-shell \"bash /s/pane-group-close %4\"",
            ]
        );
        assert_eq!(
            lines(&disarm(&pid("%4"))),
            [
                "set-option -pu -t %4 remain-on-exit",
                "set-hook -pu -t %4 pane-died"
            ]
        );
    }

    #[test]
    fn a_lone_survivor_is_ungrouped_and_a_pair_is_left_alone() {
        assert_eq!(
            lines(&dissolve_if_alone(&[pid("%4")])),
            [
                "set-option -pu -t %4 @tmuxy-group-id",
                "set-option -pu -t %4 remain-on-exit",
                "set-hook -pu -t %4 pane-died",
                "set-option -pu -t %4 @tmuxy-group-pos",
            ]
        );
        assert!(dissolve_if_alone(&[pid("%4"), pid("%7")]).is_empty());
        assert!(dissolve_if_alone(&[]).is_empty());
    }

    #[test]
    fn the_rev_bump_writes_the_token_globally() {
        assert_eq!(
            lines(&[bump_rev(&ctx())]),
            ["set-option -g @tmuxy-group-rev T"]
        );
    }

    #[test]
    fn add_to_an_ungrouped_pane_opens_a_group_named_after_it() {
        let panes = Panes::new(vec![
            row("%1", "@1", "", None, "work"),
            row("%0", "@0", "", None, STASH_SESSION),
        ]);
        let plan = add(&panes, &pid("%1"), &ctx()).unwrap();
        assert_eq!(plan.group, gid("g1"));
        assert_eq!(
            lines(&plan.before),
            [
                "set-option -p -t %1 @tmuxy-group-id g1",
                "set-option -p -t %1 remain-on-exit on",
                "set-hook -p -t %1 pane-died run-shell \"bash /s/pane-group-close %1\"",
            ]
        );
        assert_eq!(
            plan.split,
            cmd(&["split-window", "-d", "-P", "-F", "#{pane_id}", "-t", "%1"])
        );
        assert_eq!(
            lines(&add_finish(
                &pid("%1"),
                &plan.group,
                &pid("%9"),
                (100, 30),
                &ctx()
            )),
            [
                "break-pane -d -s %9 -t __tmuxy_stash:",
                "set-option -p -t %9 @tmuxy-group-id g1",
                "set-option -p -t %9 remain-on-exit on",
                "set-hook -p -t %9 pane-died run-shell \"bash /s/pane-group-close %9\"",
                "resize-window -t %9 -x 100 -y 30",
                "swap-pane -s %9 -t %1",
            ]
        );
    }

    #[test]
    fn add_to_a_member_keeps_its_group_and_sweeps_orphans_and_makes_the_stash() {
        let panes = Panes::new(vec![
            row("%1", "@1", "g1", None, "work"),
            row("%8", "@8", "g5", None, STASH_SESSION),
        ]);
        let plan = add(&panes, &pid("%1"), &ctx()).unwrap();
        assert_eq!(plan.group, gid("g1"));
        assert_eq!(lines(&plan.before), ["kill-window -t @8"]);

        let no_stash = Panes::new(vec![row("%1", "@1", "g1", None, "work")]);
        let plan = add(&no_stash, &pid("%1"), &ctx()).unwrap();
        assert!(lines(&plan.before)[0].starts_with("new-session -d -s __tmuxy_stash"));
    }

    #[test]
    fn add_refuses_a_pane_that_is_not_there() {
        assert_eq!(
            add(&grouped(), &pid("%99"), &ctx()),
            Err(GroupError::NoSuchPane(pid("%99")))
        );
    }

    #[test]
    fn park_arms_the_anchor_splits_in_its_directory_and_keeps_the_place() {
        let panes = grouped();
        let plan = park_split(&panes, &pid("%1"), &gid("g1"), "/w d", &ctx()).unwrap();
        assert_eq!(
            lines(&plan.before),
            [
                "set-option -p -t %1 remain-on-exit on",
                "set-hook -p -t %1 pane-died run-shell \"bash /s/pane-group-close %1\"",
            ]
        );
        assert_eq!(&plan.split[plan.split.len() - 2..], ["-c", "/w d"]);
        let finish = lines(&park_finish(
            &panes,
            &pid("%1"),
            &gid("g1"),
            &pid("%9"),
            Some(2),
            &ctx(),
        ));
        assert_eq!(finish[0], "break-pane -d -s %9 -t __tmuxy_stash:");
        assert_eq!(finish[1], "set-option -p -t %9 @tmuxy-group-id g1");
        assert_eq!(finish[4], "set-option -p -t %9 @tmuxy-group-pos 2");
        assert_eq!(finish[5], "resize-window -t %9 -x 80 -y 24");
        let unplaced = lines(&park_finish(
            &panes,
            &pid("%1"),
            &gid("g1"),
            &pid("%9"),
            None,
            &ctx(),
        ));
        assert!(!unplaced.iter().any(|l| l.contains("group-pos")));
    }

    #[test]
    fn closing_the_visible_member_promotes_the_next_in_order() {
        let plan = close(&grouped(), &pid("%1")).unwrap();
        assert_eq!(lines(&plan), ["swap-pane -s %1 -t %4", "kill-window -t @4"]);
        // The swap and the kill are one list.
        assert_eq!(plan[0].commands.len(), 2);
    }

    #[test]
    fn closing_a_parked_member_removes_its_stash_window() {
        assert_eq!(
            lines(&close(&grouped(), &pid("%7")).unwrap()),
            ["kill-window -t @7"]
        );
    }

    #[test]
    fn closing_down_to_one_member_dissolves_the_group() {
        let panes = Panes::new(vec![
            row("%1", "@1", "g1", None, "work"),
            row("%4", "@4", "g1", Some(1), STASH_SESSION),
        ]);
        assert_eq!(
            lines(&close(&panes, &pid("%4")).unwrap()),
            [
                "kill-window -t @4",
                "set-option -pu -t %1 @tmuxy-group-id",
                "set-option -pu -t %1 remain-on-exit",
                "set-hook -pu -t %1 pane-died",
                "set-option -pu -t %1 @tmuxy-group-pos",
            ]
        );
    }

    #[test]
    fn closing_a_pane_outside_any_group_kills_it() {
        assert_eq!(
            lines(&close(&grouped(), &pid("%2")).unwrap()),
            ["kill-pane -t %2"]
        );
    }

    #[test]
    fn closing_a_sole_visible_member_kills_it_in_place() {
        let panes = Panes::new(vec![row("%1", "@1", "g1", None, "work")]);
        assert_eq!(
            lines(&close(&panes, &pid("%1")).unwrap()),
            ["kill-pane -t %1"]
        );
    }

    #[test]
    fn closing_also_sweeps_orphaned_groups() {
        let mut rows = grouped().rows;
        rows.push(row("%8", "@8", "g5", None, STASH_SESSION));
        let plan = close(&Panes::new(rows), &pid("%7")).unwrap();
        assert_eq!(lines(&plan), ["kill-window -t @7", "kill-window -t @8"]);
    }

    #[test]
    fn switch_resizes_the_target_window_then_swaps_it_into_view() {
        let mut rows = grouped().rows;
        rows[1].width = 120;
        rows[1].height = 40;
        let plan = switch(&Panes::new(rows), &pid("%7"));
        assert_eq!(
            lines(&plan),
            ["resize-window -t @7 -x 120 -y 40", "swap-pane -s %7 -t %1"]
        );
        assert_eq!(plan.len(), 1, "resize and swap are one list");
    }

    #[test]
    fn switch_to_the_visible_member_or_a_loose_pane_does_nothing() {
        assert!(switch(&grouped(), &pid("%1")).is_empty());
        assert!(switch(&grouped(), &pid("%2")).is_empty());
        assert!(switch(&grouped(), &pid("%99")).is_empty());
    }

    #[test]
    fn next_and_prev_wrap_around_the_order() {
        let panes = grouped();
        assert_eq!(
            lines(&step(&panes, &pid("%1"), Direction::Next))[1],
            "swap-pane -s %4 -t %1"
        );
        assert_eq!(
            lines(&step(&panes, &pid("%1"), Direction::Prev))[1],
            "swap-pane -s %7 -t %1"
        );
        // The group is named by any member; the step is from the visible one.
        assert_eq!(
            lines(&step(&panes, &pid("%7"), Direction::Next))[1],
            "swap-pane -s %4 -t %1"
        );
    }

    #[test]
    fn next_follows_a_rearranged_order() {
        let panes = Panes::new(vec![
            row("%1", "@1", "g1", Some(0), "work"),
            row("%4", "@4", "g1", Some(2), STASH_SESSION),
            row("%7", "@7", "g1", Some(1), STASH_SESSION),
        ]);
        assert_eq!(
            lines(&step(&panes, &pid("%1"), Direction::Next))[1],
            "swap-pane -s %7 -t %1"
        );
    }

    #[test]
    fn stepping_outside_a_group_does_nothing() {
        assert!(step(&grouped(), &pid("%2"), Direction::Next).is_empty());
        let alone = Panes::new(vec![row("%1", "@1", "g1", None, "work")]);
        assert!(step(&alone, &pid("%1"), Direction::Next).is_empty());
    }

    #[test]
    fn move_writes_every_members_place() {
        assert_eq!(
            lines(&move_to(&grouped(), &pid("%7"), 0, &ctx()).unwrap()),
            [
                "set-option -p -t %7 @tmuxy-group-pos 0",
                "set-option -p -t %1 @tmuxy-group-pos 1",
                "set-option -p -t %4 @tmuxy-group-pos 2",
                "set-option -g @tmuxy-group-rev T",
            ]
        );
    }

    #[test]
    fn move_clamps_the_index() {
        let last = lines(&move_to(&grouped(), &pid("%1"), 99, &ctx()).unwrap());
        assert_eq!(last[2], "set-option -p -t %1 @tmuxy-group-pos 2");
        let first = lines(&move_to(&grouped(), &pid("%7"), -3, &ctx()).unwrap());
        assert_eq!(first[0], "set-option -p -t %7 @tmuxy-group-pos 0");
    }

    #[test]
    fn move_refuses_a_pane_outside_any_group() {
        assert_eq!(
            move_to(&grouped(), &pid("%2"), 0, &ctx()),
            Err(GroupError::NotInGroup(pid("%2")))
        );
        assert_eq!(
            GroupError::NotInGroup(pid("%2")).to_string(),
            "%2 is not in a group"
        );
    }

    #[test]
    fn join_parks_the_pane_sized_to_the_visible_slot_at_its_place() {
        let mut rows = grouped().rows;
        rows[1].width = 100;
        rows[1].height = 30;
        assert_eq!(
            lines(&join(&Panes::new(rows), &pid("%2"), &pid("%4"), Some(1), &ctx()).unwrap()),
            [
                "break-pane -d -s %2 -t __tmuxy_stash:",
                "set-option -p -t %2 @tmuxy-group-id g1",
                "set-option -p -t %2 remain-on-exit on",
                "set-hook -p -t %2 pane-died run-shell \"bash /s/pane-group-close %2\"",
                "resize-window -t %2 -x 100 -y 30",
                "set-option -p -t %1 @tmuxy-group-pos 0",
                "set-option -p -t %2 @tmuxy-group-pos 1",
                "set-option -p -t %4 @tmuxy-group-pos 2",
                "set-option -p -t %7 @tmuxy-group-pos 3",
                "set-option -g @tmuxy-group-rev T",
            ]
        );
    }

    #[test]
    fn join_without_an_index_goes_last() {
        let plan = lines(&join(&grouped(), &pid("%2"), &pid("%1"), None, &ctx()).unwrap());
        assert!(plan.contains(&"set-option -p -t %2 @tmuxy-group-pos 3".to_string()));
    }

    #[test]
    fn join_onto_a_loose_pane_opens_a_group_named_after_it() {
        let panes = Panes::new(vec![
            row("%0", "@0", "", None, STASH_SESSION),
            row("%3", "@3", "", None, "work"),
            row("%5", "@3", "", None, "work"),
        ]);
        let plan = lines(&join(&panes, &pid("%5"), &pid("%3"), None, &ctx()).unwrap());
        assert_eq!(plan[0], "set-option -p -t %3 @tmuxy-group-id g3");
        assert!(plan.contains(&"set-option -p -t %5 @tmuxy-group-id g3".to_string()));
        assert!(plan.contains(&"set-option -p -t %3 @tmuxy-group-pos 0".to_string()));
        assert!(plan.contains(&"set-option -p -t %5 @tmuxy-group-pos 1".to_string()));
    }

    #[test]
    fn join_refuses_what_it_cannot_do() {
        let panes = grouped();
        assert_eq!(
            join(&panes, &pid("%1"), &pid("%1"), None, &ctx()),
            Err(GroupError::JoinSelf)
        );
        assert_eq!(
            join(&panes, &pid("%4"), &pid("%2"), None, &ctx()),
            Err(GroupError::AlreadyGrouped(pid("%4")))
        );
        let lonely = Panes::new(vec![
            row("%1", "@1", "", None, "solo"),
            row("%2", "@2", "", None, "work"),
        ]);
        assert_eq!(
            join(&lonely, &pid("%1"), &pid("%2"), None, &ctx()),
            Err(GroupError::LastPaneOfSession(pid("%1")))
        );
        assert_eq!(
            GroupError::LastPaneOfSession(pid("%1")).to_string(),
            "%1 is the last pane of its session"
        );
    }

    #[test]
    fn leaving_from_the_slot_hands_it_to_the_next_member_then_becomes_a_tab() {
        let plan = lines(&leave(&grouped(), &pid("%1"), &Leave::Tab, &ctx()).unwrap());
        assert_eq!(
            plan,
            [
                "resize-window -t @4 -x 80 -y 24",
                "swap-pane -s %4 -t %1",
                "set-option -pu -t %1 @tmuxy-group-id",
                "set-option -pu -t %1 remain-on-exit",
                "set-hook -pu -t %1 pane-died",
                "set-option -pu -t %1 @tmuxy-group-pos",
                // %1 now sits in %4's old stash window.
                "move-window -s @4 -t work:",
                "select-window -t @4",
                "set-option -p -t %4 @tmuxy-group-pos 0",
                "set-option -p -t %7 @tmuxy-group-pos 1",
                "set-option -g @tmuxy-group-rev T",
            ]
        );
    }

    #[test]
    fn the_last_member_in_order_hands_the_slot_to_the_one_before() {
        // Order: %4, %9, %7, %1 — the slot owner is last.
        let panes = Panes::new(vec![
            row("%1", "@1", "g1", Some(3), "work"),
            row("%4", "@4", "g1", Some(0), STASH_SESSION),
            row("%7", "@7", "g1", Some(2), STASH_SESSION),
            row("%9", "@9", "g1", Some(1), STASH_SESSION),
        ]);
        let plan = lines(&leave(&panes, &pid("%1"), &Leave::Tab, &ctx()).unwrap());
        assert_eq!(plan[1], "swap-pane -s %7 -t %1");
    }

    #[test]
    fn a_parked_member_leaves_beside_a_pane_and_a_pair_dissolves() {
        let panes = Panes::new(vec![
            row("%1", "@1", "g1", None, "work"),
            row("%2", "@1", "", None, "work"),
            row("%4", "@4", "g1", None, STASH_SESSION),
        ]);
        let to = Leave::Beside {
            target: pid("%2"),
            side: Side::Up,
        };
        assert_eq!(
            lines(&leave(&panes, &pid("%4"), &to, &ctx()).unwrap()),
            [
                "set-option -pu -t %4 @tmuxy-group-id",
                "set-option -pu -t %4 remain-on-exit",
                "set-hook -pu -t %4 pane-died",
                "set-option -pu -t %4 @tmuxy-group-pos",
                "join-pane -v -b -s %4 -t %2",
                "set-option -pu -t %1 @tmuxy-group-id",
                "set-option -pu -t %1 remain-on-exit",
                "set-hook -pu -t %1 pane-died",
                "set-option -pu -t %1 @tmuxy-group-pos",
                "set-option -g @tmuxy-group-rev T",
            ]
        );
    }

    #[test]
    fn a_parked_member_leaving_as_a_tab_takes_its_own_window() {
        let plan = lines(&leave(&grouped(), &pid("%7"), &Leave::Tab, &ctx()).unwrap());
        assert!(plan.contains(&"move-window -s @7 -t work:".to_string()));
        assert!(!plan.iter().any(|l| l.starts_with("swap-pane")));
    }

    #[test]
    fn sides_map_to_join_pane_flags() {
        assert_eq!(Side::parse("left").unwrap().join_flags(), ["-h", "-b"]);
        assert_eq!(Side::parse("").unwrap(), Side::Right);
        assert_eq!(Side::parse("down").unwrap().join_flags(), ["-v"]);
        assert_eq!(
            Side::parse("sideways").unwrap_err().to_string(),
            "direction must be left, right, up or down"
        );
    }

    #[test]
    fn leave_refuses_a_pane_outside_any_group() {
        assert_eq!(
            leave(&grouped(), &pid("%2"), &Leave::Tab, &ctx()),
            Err(GroupError::NotInGroup(pid("%2")))
        );
    }
}
