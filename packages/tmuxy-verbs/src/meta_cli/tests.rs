//! The verb against a pane that keeps its `@tmuxy-meta` in memory, as tmux
//! would: what is written, what a reader then finds, and each refusal.

use super::*;
use std::sync::Mutex;
use tmuxy_core::CommandError;

#[derive(Default)]
struct Pane {
    option: Mutex<String>,
    writes: Mutex<Vec<String>>,
}

impl ask::Tmux for Pane {
    async fn read(&self, argv: Argv) -> Result<String, CommandError> {
        assert_eq!(argv[..4], ["display-message", "-p", "-t", "%3"]);
        Ok(self.option.lock().unwrap().clone())
    }

    async fn mutate(&self, commands: Vec<Argv>) -> Result<(), CommandError> {
        for argv in commands {
            self.writes.lock().unwrap().push(argv.join(" "));
            match argv[1].as_str() {
                "-p" => *self.option.lock().unwrap() = argv[5].clone(),
                "-pu" => self.option.lock().unwrap().clear(),
                other => panic!("unexpected {other}"),
            }
        }
        Ok(())
    }
}

impl Pane {
    fn fields(&self) -> Fields {
        pane_meta::decode(&self.option.lock().unwrap())
    }
}

const NOW: u64 = 1_000_000;

async fn run(pane: &Pane, action: MetaAction, at: u64) -> Result<(), (i32, String)> {
    let args = MetaArgs {
        target: "%3".into(),
        json: false,
        action,
    };
    meta(pane, args, &Answer::new(false), at).await
}

fn set(pairs: &[&str], ttl: Option<&str>) -> MetaAction {
    MetaAction::Set {
        ttl: ttl.map(String::from),
        pairs: pairs.iter().map(|p| p.to_string()).collect(),
    }
}

#[tokio::test]
async fn fields_are_set_replaced_unset_and_cleared_on_the_pane() {
    let pane = Pane::default();
    run(
        &pane,
        set(&["ci=passing", "task=parser rewrite"], None),
        NOW,
    )
    .await
    .unwrap();
    let fields = pane.fields();
    assert_eq!(fields["ci"].value, "passing");
    assert_eq!(fields["task"].value, "parser rewrite");
    assert!(pane.writes.lock().unwrap()[0].starts_with("set-option -p -t %3 @tmuxy-meta "));

    // A value may hold `=`: only the first one splits.
    run(&pane, set(&["ci=failing: a=b"], None), NOW)
        .await
        .unwrap();
    assert_eq!(pane.fields()["ci"].value, "failing: a=b");
    assert_eq!(pane.fields().len(), 2);

    run(
        &pane,
        MetaAction::Unset {
            keys: vec!["ci".into(), "absent".into()],
        },
        NOW,
    )
    .await
    .unwrap();
    assert_eq!(pane.fields().keys().collect::<Vec<_>>(), ["task"]);

    // The last field gone is the option gone, not an empty one.
    run(&pane, MetaAction::Clear, NOW).await.unwrap();
    assert_eq!(
        pane.writes.lock().unwrap().last().unwrap(),
        "set-option -pu -t %3 @tmuxy-meta"
    );
    assert!(pane.option.lock().unwrap().is_empty());
}

#[tokio::test]
async fn a_field_with_a_time_to_live_is_gone_once_its_time_is_up() {
    let pane = Pane::default();
    run(&pane, set(&["deploy=running"], Some("5m")), NOW)
        .await
        .unwrap();
    run(&pane, set(&["owner=me"], None), NOW).await.unwrap();
    assert_eq!(pane.fields()["deploy"].until, Some(NOW + 300));
    // The next write after its time leaves it out.
    run(&pane, set(&["owner=you"], None), NOW + 300)
        .await
        .unwrap();
    assert_eq!(pane.fields().keys().collect::<Vec<_>>(), ["owner"]);
}

#[tokio::test]
async fn what_breaks_the_rules_is_refused_and_writes_nothing() {
    let pane = Pane::default();
    for (action, code) in [
        (set(&["no-equals"], None), EXIT_USAGE),
        (set(&["Upper=x"], None), EXIT_USAGE),
        (set(&["ci="], None), EXIT_USAGE),
        (set(&["ci=   "], None), EXIT_USAGE),
        (set(&[&format!("ci={}", "x".repeat(81))], None), EXIT_USAGE),
        (set(&["ci=x"], Some("soon")), EXIT_USAGE),
        (
            MetaAction::Unset {
                keys: vec!["Bad Key".into()],
            },
            EXIT_USAGE,
        ),
    ] {
        let (got, message) = run(&pane, action, NOW).await.unwrap_err();
        assert_eq!(got, code, "{message}");
    }
    // Nine fields, eight allowed: refused whole, nothing half written.
    let nine: Vec<String> = (0..9).map(|i| format!("k{i}=v")).collect();
    let nine: Vec<&str> = nine.iter().map(String::as_str).collect();
    let (code, message) = run(&pane, set(&nine, None), NOW).await.unwrap_err();
    assert_eq!(code, EXIT_FAILED);
    assert!(message.contains("at most 8"), "{message}");
    assert!(pane.writes.lock().unwrap().is_empty());

    let (code, _) = meta(
        &pane,
        MetaArgs {
            target: "three".into(),
            json: false,
            action: MetaAction::List,
        },
        &Answer::new(false),
        NOW,
    )
    .await
    .unwrap_err();
    assert_eq!(code, EXIT_USAGE);
}

#[test]
fn the_listing_and_the_json_say_what_is_shown_and_for_how_long() {
    let fields = Fields::from([
        (
            "ci".to_string(),
            Field {
                value: "passing".into(),
                until: None,
            },
        ),
        (
            "deploy".to_string(),
            Field {
                value: "running".into(),
                until: Some(NOW + 42),
            },
        ),
    ]);
    assert_eq!(
        listing(&fields, NOW),
        "ci      passing\ndeploy  running  (for 42s)"
    );
    assert_eq!(listing(&Fields::new(), NOW), "no fields");
    let pane = PaneId::parse("%3").unwrap();
    let json: serde_json::Value = serde_json::from_str(&report(&pane, &fields, NOW)[1].1).unwrap();
    assert_eq!(json["deploy"]["secondsLeft"], 42);
    assert_eq!(json["ci"]["secondsLeft"], serde_json::Value::Null);
}
