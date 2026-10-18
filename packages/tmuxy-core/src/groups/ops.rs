use crate::constants::tmux_options;
use crate::{GroupId, PaneId};

use super::{
    arm, bump_rev, cmd, dissolve_if_alone, ensure_stash, gc, ids, insert_at, park, set_order,
    split, swap_into_view, ungroup, Context, GroupError, Invocation, Panes,
};

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
    step_by(panes, pane, |at, len| match direction {
        Direction::Next => Some((at + 1) % len),
        Direction::Prev => Some((at + len - 1) % len),
    })
}

/// `step` without wrapping: nothing past the last (or before the first)
/// member, which is where Ctrl+l / Ctrl+h move on to the neighbouring pane.
pub fn step_within(panes: &Panes, pane: &PaneId, direction: Direction) -> Vec<Invocation> {
    step_by(panes, pane, |at, len| match direction {
        Direction::Next => (at + 1 < len).then_some(at + 1),
        Direction::Prev => at.checked_sub(1),
    })
}

/// Switch to the member `pick` chooses, given the visible member's place and
/// the group's size.
fn step_by(
    panes: &Panes,
    pane: &PaneId,
    pick: impl Fn(usize, usize) -> Option<usize>,
) -> Vec<Invocation> {
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
    match pick(at, members.len()) {
        Some(target) if target != at => switch(panes, &members[target].pane),
        _ => Vec::new(),
    }
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

    pub(super) fn join_flags(self) -> &'static [&'static str] {
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
