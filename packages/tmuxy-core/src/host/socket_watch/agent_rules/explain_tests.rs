use super::*;
use crate::host::socket_watch::agent_rules::user;

fn facts(state: &str, rules_state: &str, rules_why: &str) -> Facts {
    Facts {
        state: state.into(),
        rules_state: rules_state.into(),
        rules_why: rules_why.into(),
        command: "node".into(),
        ..Facts::default()
    }
}

fn user_rules() -> UserRules {
    let agent = user::parse(
        "helper",
        "command = \"my-helper\"\n[[rule]]\nmatch = 'Waiting for your reply'\nstate = \"needs-input\"\n",
    )
    .unwrap();
    let mut rules = UserRules::default();
    rules.agents.push(agent);
    rules
        .problems
        .push("bad.toml: rule 1: unclosed group".into());
    rules
}

#[test]
fn a_reason_round_trips_through_its_token() {
    for why in [
        Why::Dialog,
        Why::Changed,
        Why::Still,
        Why::User {
            file: "helper.toml".into(),
            rule: 2,
        },
    ] {
        assert_eq!(Why::parse(&why.token()), Some(why));
    }
    assert_eq!(Why::parse("user:helper.toml:x"), None);
    assert_eq!(Why::parse("something"), None);
}

#[test]
fn a_state_the_rules_wrote_names_the_rule_and_its_pattern() {
    let user = user_rules();
    let found = explain(
        &facts("needs-input", "needs-input", "user:helper.toml:1"),
        "my-helper",
        &user,
    );
    assert_eq!(found.source, Source::ScreenRules);
    assert_eq!(
        found.rule.as_deref(),
        Some("helper.toml rule 1 matched 'Waiting for your reply'")
    );
    assert_eq!(found.read_by, ReadBy::UserRules("helper.toml".into()));
    let text = found.render("%5");
    assert_eq!(
        text,
        "%5 needs-input\n\
         source: the screen rules: helper.toml rule 1 matched 'Waiting for your reply'\n\
         program: my-helper (tmux names it node)\n\
         read by: the screen rules, with helper.toml first\n\
         left out: bad.toml: rule 1: unclosed group"
    );

    let signs = explain(
        &facts("idle", "idle", "still"),
        "gemini",
        &UserRules::default(),
    );
    assert_eq!(
        signs.rule.as_deref(),
        Some("the screen held still for 3 passes")
    );
    assert_eq!(signs.read_by, ReadBy::ScreenRules);
    let gone = explain(&facts("idle", "idle", "user:helper.toml:9"), "x", &user);
    assert_eq!(
        gone.rule.as_deref(),
        Some("helper.toml rule 9 (no longer in the file)")
    );
}

#[test]
fn a_state_that_differs_from_the_rules_note_was_declared() {
    let none = UserRules::default();
    let declared = explain(&facts("error", "working", "changed"), "gemini", &none);
    assert_eq!(declared.source, Source::Declared);
    assert_eq!(declared.rule, None);
    let hooked = Facts {
        command: "claude".into(),
        ..facts("working", "", "")
    };
    let by_hook = explain(&hooked, "claude", &none);
    assert_eq!(by_hook.source, Source::Declared);
    assert_eq!(by_hook.read_by, ReadBy::Hooks);
    let asking = Facts {
        asking: true,
        ..facts("needs-input", "", "")
    };
    assert_eq!(explain(&asking, "zsh", &none).source, Source::Question);
    let nothing = explain(&facts("", "", ""), "zsh", &none);
    assert_eq!(nothing.source, Source::None);
    assert_eq!(nothing.read_by, ReadBy::Nothing);
    assert!(nothing
        .render("%1")
        .starts_with("%1 no state\nsource: nothing has set one\n"));
}

#[test]
fn the_facts_read_back_from_their_format() {
    assert_eq!(
        facts_format(),
        "#{@tmuxy-rules-state}\t#{@tmuxy-rules-why}\t#{?@tmuxy-ask,1,}\t\
         #{pane_current_command}\t#{pane_pid}\t#{@tmuxy-pane-state}"
    );
    let read = Facts::parse("idle\tstill\t\tnode\t4021\tidle\n").unwrap();
    assert_eq!(read.pid, Some(4021));
    assert!(!read.asking);
    assert_eq!(read.rules_why, "still");
    assert_eq!(read.state, "idle");
    // A state anything wrote, tab and all, stays one value.
    let odd = Facts::parse("\t\t1\tzsh\t7\tmy\tstate").unwrap();
    assert_eq!(odd.state, "my\tstate");
    assert!(odd.asking);
    assert_eq!(Facts::parse("too\tfew"), None);
}

#[test]
fn the_json_answer_keeps_its_shape() {
    let found = explain(
        &facts("idle", "idle", "still"),
        "gemini",
        &UserRules::default(),
    );
    let json = serde_json::to_value(&found).unwrap();
    assert_eq!(json["source"], "screen-rules");
    assert_eq!(json["readBy"]["kind"], "screen-rules");
    assert_eq!(json["program"], "gemini");
}
