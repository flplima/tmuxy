use super::tests::{ctx, grouped, lines, row};
use super::*;
use crate::ids::test_ids::pid;

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
fn stepping_within_stops_at_either_end() {
    let panes = grouped();
    assert_eq!(
        lines(&step_within(&panes, &pid("%1"), Direction::Next))[1],
        "swap-pane -s %4 -t %1"
    );
    assert!(step_within(&panes, &pid("%1"), Direction::Prev).is_empty());
    // Order %4, %7, %1: the one on screen is last.
    let mut rows = panes.rows.clone();
    rows[1].pos = Some(2);
    rows[3].pos = Some(0);
    rows[4].pos = Some(1);
    let last = Panes::new(rows);
    assert!(step_within(&last, &pid("%1"), Direction::Next).is_empty());
    assert_eq!(
        lines(&step_within(&last, &pid("%1"), Direction::Prev))[1],
        "swap-pane -s %7 -t %1"
    );
    assert!(step_within(&panes, &pid("%2"), Direction::Next).is_empty());
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
