use super::*;
use crate::ids::test_ids::{gid, pid, wid};

pub(super) fn ctx() -> Context {
    Context {
        close_command: "/s/pane-group close".to_string(),
        rev_token: "T".to_string(),
    }
}

pub(super) fn row(
    pane: &str,
    window: &str,
    group: &str,
    pos: Option<u32>,
    session: &str,
) -> PaneRow {
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
pub(super) fn lines(plan: &[Invocation]) -> Vec<String> {
    plan.iter()
        .flat_map(|i| i.commands.iter().map(|c| c.join(" ")))
        .collect()
}

/// `work` shows `%1` (group g1, with `%4` and `%7` parked) beside `%2`;
/// the stash's own first window is `%0`.
pub(super) fn grouped() -> Panes {
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
    let panes = Panes::parse("%1 @1 g1 2 80 24 work\n%2 @1   40 12 my session\nnot a row\n");
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
            "set-hook -p -t %4 pane-died run-shell \"bash /s/pane-group close %4\"",
        ]
    );
    assert_eq!(
        lines(&disarm(&pid("%4"))),
        [
            "set-option -pu -t %4 remain-on-exit",
            "set-hook -pu -t %4 pane-died"
        ]
    );
    let quoted_script =
        quote_script_path(std::path::Path::new("/Users/o'malley/a #1 $dir/pane-group"));
    let special_ctx = Context {
        close_command: format!("{quoted_script} close"),
        rev_token: "T".into(),
    };
    assert_eq!(
        lines(&arm(&pid("%4"), &special_ctx))[1],
        "set-hook -p -t %4 pane-died run-shell \"bash '/Users/o'\\\\''malley/a ##1 \\$dir/pane-group' close %4\"",
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
            "set-hook -p -t %1 pane-died run-shell \"bash /s/pane-group close %1\"",
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
            "set-hook -p -t %9 pane-died run-shell \"bash /s/pane-group close %9\"",
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
            "set-hook -p -t %1 pane-died run-shell \"bash /s/pane-group close %1\"",
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
