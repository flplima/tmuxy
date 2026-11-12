use super::*;

/// The screen at each pass, and what the rules make of it.
fn judged(screens: &[&str]) -> Vec<Option<&'static str>> {
    let mut track = None;
    screens
        .iter()
        .map(|screen| judge(&mut track, screen).map(PaneStateName::as_str))
        .collect()
}

#[test]
fn a_changing_screen_is_working_and_one_held_still_is_idle() {
    assert_eq!(
        judged(&["a", "ab", "abc", "abc", "abc", "abc", "abcd"]),
        [
            None,
            Some("working"),
            Some("working"),
            None,
            None,
            Some("idle"),
            Some("working")
        ]
    );
}

#[test]
fn the_first_sight_of_a_screen_says_nothing_yet() {
    assert_eq!(judged(&["still"]), [None]);
    assert_eq!(judged(&["still", "still", "still"]), [None, None, None]);
    assert_eq!(
        judged(&["still", "still", "still", "still"])[3],
        Some("idle")
    );
}

#[test]
fn a_dialog_on_screen_is_needs_input_at_once() {
    let dialog = "Do you want to run this?\n❯ 1. Yes\n  2. No";
    assert_eq!(judged(&[dialog]), [Some("needs-input")]);
    assert_eq!(judged(&["a", dialog, dialog])[2], Some("needs-input"));
}

#[test]
fn the_rules_write_only_over_their_own_state_or_none() {
    use PaneStateName::{Idle, NeedsInput, Working};
    // Unset: the rules may write.
    assert_eq!(
        decide("", "", Some(Working), false),
        Some(Change::Set("working"))
    );
    // Their own, and the screen says something else: they change it.
    assert_eq!(
        decide("working", "working", Some(Idle), false),
        Some(Change::Set("idle"))
    );
    // Their own and unchanged: nothing to write.
    assert_eq!(decide("idle", "idle", Some(Idle), false), None);
    // A hook declared it (it is not what the rules last wrote): hands off.
    assert_eq!(decide("needs-input", "working", Some(Working), false), None);
    assert_eq!(decide("error", "", Some(Idle), false), None);
    // A send is asking on the pane: its question owns the state.
    assert_eq!(decide("", "", Some(NeedsInput), true), None);
    // No sign yet: nothing.
    assert_eq!(decide("", "", None, false), None);
}

#[test]
fn only_the_agents_without_hooks_are_read() {
    for agent in RULE_AGENTS {
        assert!(is_rule_agent(agent));
        assert!(
            !super::super::agent_screen::is_agent(agent),
            "{agent} has hooks"
        );
    }
    for other in ["claude", "codex", "zsh", "bash", "vim"] {
        assert!(!is_rule_agent(other), "{other}");
    }
}

#[test]
fn a_write_happens_only_while_the_state_still_reads_what_the_pass_read() {
    let set = guarded_command("%5", "working", &Change::Set("idle")).unwrap();
    assert_eq!(
        set,
        [
            "if-shell",
            "-F",
            "-t",
            "%5",
            "#{==:#{@tmuxy-pane-state},working}",
            "set-option -p -t %5 @tmuxy-pane-state idle ; set-option -p -t %5 @tmuxy-rules-state idle",
        ]
    );
    let clear = guarded_command("%5", "", &Change::Clear).unwrap();
    assert_eq!(clear[4], "#{==:#{@tmuxy-pane-state},}");
    assert_eq!(
        clear[5],
        "set-option -pu -t %5 @tmuxy-pane-state ; set-option -pu -t %5 @tmuxy-rules-state"
    );
}

#[test]
fn a_state_that_is_not_a_state_word_is_never_put_in_the_condition() {
    assert_eq!(guarded_command("%5", "idle},1}", &Change::Clear), None);
    assert_eq!(guarded_command("%5", "busy", &Change::Set("idle")), None);
}
