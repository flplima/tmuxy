use std::collections::HashMap;

use super::tests_capture::{fixture, joined, window_line};
use super::*;
use crate::ids::test_ids::pid;

/// The restore-on-start path builds onto the window `new-session -A` made.
#[test]
fn restoring_onto_an_existing_session_renames_window_zero_instead_of_creating() {
    let lines = joined(&plan(
        &fixture(),
        &RestoreOptions {
            onto_existing_window: true,
            ..Default::default()
        },
    ));
    assert!(!lines.iter().any(|l| l.starts_with("run: new-session")));
    assert_eq!(lines[0], "run: rename-window -t work:0 main");
    // With `base-index 1` the placeholder sits at 1 and must be moved to
    // the snapshot's first index — the failure the first real restore hit.
    let based = joined(&plan(
        &fixture(),
        &RestoreOptions {
            onto_existing_window: true,
            existing_window_index: Some(1),
            ..Default::default()
        },
    ));
    assert_eq!(based[0], "run: rename-window -t work:1 main");
    assert_eq!(based[1], "run: move-window -s work:1 -t work:0");
    assert!(
        !lines.iter().any(|l| l.starts_with("run: move-window")),
        "the first window is at 0 already"
    );
    // The hint names the first window and its first pane's directory.
    let snap = fixture();
    let (name, cwd) = snap.first_window_hint("/home/x").unwrap();
    assert_eq!(name, "main");
    assert_eq!(cwd, "/tmp");
}

#[test]
fn a_tmux_word_quotes_what_tmux_would_otherwise_split_or_expand() {
    // A bare `#` is a comment to tmux's parser: a format is always quoted.
    assert_eq!(tmux_word("#{window_id}"), "\"#{window_id}\"");
    assert_eq!(
        tmux_word("#{s/,/%2C/:window_layout}"),
        "\"#{s/,/%2C/:window_layout}\""
    );
    // `{` opens a command block: a side-by-side layout is quoted.
    assert_eq!(
        tmux_word("b1c2,80x24,0,0{40x24,0,0,1}"),
        "\"b1c2,80x24,0,0{40x24,0,0,1}\""
    );
    assert_eq!(tmux_word("a b"), "\"a b\"");
    assert_eq!(tmux_word("say \"hi\" $HOME"), "\"say \\\"hi\\\" \\$HOME\"");
}

#[test]
fn a_delta_is_structural_when_the_shape_moves_not_when_output_arrives() {
    let mut d = crate::TmuxDelta {
        seq: 1,
        panes: None,
        windows: None,
        new_panes: None,
        new_windows: None,
        active_window_id: None,
        active_pane_id: None,
        focus_request: None,
        total_width: None,
        total_height: None,
    };
    assert!(!is_structural(&d));
    let mut panes = std::collections::HashMap::new();
    panes.insert(
        pid("%1"),
        Some(crate::PaneDelta {
            content: Some(Default::default()),
            ..Default::default()
        }),
    );
    d.panes = Some(panes.clone());
    assert!(!is_structural(&d), "output alone is not a shape change");
    panes.insert(pid("%2"), None);
    d.panes = Some(panes);
    assert!(is_structural(&d), "a pane going away is");
    d.panes = None;
    d.active_pane_id = Some(pid("%1"));
    assert!(is_structural(&d));
}

#[test]
fn focus_is_restored_last() {
    let lines = joined(&plan(&fixture(), &RestoreOptions::default()));
    assert_eq!(lines.last().unwrap(), "run: select-window -t work:2");
    assert!(lines.contains(&"run: select-pane -t work:0.1".to_string()));
}

/// The executor threads each answer into the following step.
#[tokio::test]
async fn apply_feeds_an_answer_into_the_next_step() {
    let mut seen = Vec::new();
    apply(&fixture(), &RestoreOptions::default(), |argv| {
        seen.push(argv.join(" "));
        std::future::ready(Ok(if argv[0] == "split-window" {
            "%9\n".into()
        } else if argv[0] == "display-message" {
            "@7\n".into()
        } else {
            String::new()
        }))
    })
    .await
    .unwrap();
    assert!(seen.contains(&"break-pane -d -s %9 -t work:2 -n notes".to_string()));
    assert!(seen.contains(&"set-option -w -t work:2 @tmuxy-float-parent @7".to_string()));
}

#[tokio::test]
async fn apply_stops_at_the_first_failure() {
    let result = apply(&fixture(), &RestoreOptions::default(), |argv| {
        std::future::ready(if argv[0] == "new-session" {
            Err(crate::TmuxError::other("no"))
        } else {
            Ok(String::new())
        })
    })
    .await;
    assert_eq!(result.unwrap_err().to_string(), "tmux error: no");
}

#[test]
fn assemble_ties_panes_to_windows_and_parents_to_indices() {
    let windows = parse_windows(
        &[
            window_line("@1", 0, true, "", "", "l0", "main"),
            window_line("@3", 2, false, "float", "@1", "l2", "f"),
        ]
        .join("\n"),
    );
    let panes = parse_panes("%5,@1,0,1,1,/dev/ttys1,/a,,,,\n%6,@3,0,1,2,/dev/ttys2,/b,,g1,,\n%4,@1,1,0,3,/dev/ttys3,/c,,,,");
    let mut commands = HashMap::new();
    commands.insert(pid("%5"), vec!["vim".to_string()]);
    let snap = assemble("work", 7, windows, panes, &commands);
    assert_eq!(snap.windows.len(), 2);
    assert_eq!(
        snap.windows[0]
            .panes
            .iter()
            .map(|p| p.index)
            .collect::<Vec<_>>(),
        vec![0, 1]
    );
    assert_eq!(
        snap.windows[0].panes[0].command,
        Some(vec!["vim".to_string()])
    );
    assert_eq!(snap.windows[1].float_parent_index, Some(0));
    assert_eq!(snap.windows[1].panes[0].options["@tmuxy-group-id"], "g1");
}

#[test]
fn storage_writes_atomically_skips_identical_shapes_and_tolerates_a_bad_file() {
    let dir = std::env::temp_dir().join(format!("tmuxy-snap-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let snap = fixture();
    let first = write(&dir, &snap).unwrap();
    assert!(first.is_some());
    assert!(!std::fs::read_dir(&dir).unwrap().any(|e| e
        .unwrap()
        .file_name()
        .to_str()
        .unwrap()
        .ends_with(".tmp")));
    // Same shape, later clock: nothing written.
    let again = Snapshot {
        saved_at: snap.saved_at + 60,
        ..snap.clone()
    };
    assert_eq!(write(&dir, &again).unwrap(), None);
    assert_eq!(
        read_latest(&dir, "work").unwrap().unwrap().windows,
        snap.windows
    );
    assert_eq!(list(&dir), vec![("work".to_string(), snap.saved_at)]);
    // A truncated latest is an error the caller can read, not a panic.
    std::fs::write(dir.join("work.latest.json"), "{\"version\":1,\"sess").unwrap();
    assert!(matches!(
        read_latest(&dir, "work"),
        Err(SnapshotError::Unreadable(_))
    ));
    // A newer tmuxy's file is refused by version.
    std::fs::write(
        dir.join("work.latest.json"),
        format!(
            "{{\"version\":{},\"session\":\"work\",\"saved_at\":1,\"windows\":[]}}",
            SNAPSHOT_VERSION + 1
        ),
    )
    .unwrap();
    assert_eq!(
        read_latest(&dir, "work"),
        Err(SnapshotError::NewerVersion(SNAPSHOT_VERSION + 1))
    );
    assert_eq!(read_latest(&dir, "nobody").unwrap(), None);
    assert!(forget(&dir, "work") >= 2);
    assert_eq!(read_latest(&dir, "work").unwrap(), None);
    let _ = std::fs::remove_dir_all(&dir);
}

/// A busy afternoon leaves a file per save; what survives is the last
/// five, one per hour for the day, one per day for the month.
#[test]
fn pruning_thins_out_with_age() {
    let dir = std::env::temp_dir().join(format!("tmuxy-thin-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    // Half past the hour, so twenty minutes of saves stay in one hour.
    let now = 1_759_622_400u64 + 1800;
    let hour = 3600;
    let day = 86_400;
    // Twenty saves a minute apart in the last half hour…
    for i in 0..20u64 {
        std::fs::write(dir.join(snapshot_file_name("s", now - i * 60)), "{}").unwrap();
    }
    // …three in each of the five hours before…
    for h in 1..=5u64 {
        for m in 0..3u64 {
            std::fs::write(
                dir.join(snapshot_file_name("s", now - h * hour - m * 60)),
                "{}",
            )
            .unwrap();
        }
    }
    // …two on each of three earlier days, and one past the month.
    for d in 2..=4u64 {
        for m in 0..2u64 {
            std::fs::write(
                dir.join(snapshot_file_name("s", now - d * day - m * 60)),
                "{}",
            )
            .unwrap();
        }
    }
    std::fs::write(
        dir.join(snapshot_file_name("s", now - KEEP_FOR_SECS - day)),
        "{}",
    )
    .unwrap();
    prune(&dir, "s", now);
    let left: Vec<String> = dated_files(&dir, "s")
        .iter()
        .map(|f| f.file_name().unwrap().to_str().unwrap().to_string())
        .collect();
    // 5 newest (all in the current hour), then the newest of each of the
    // five hours before, then the newest of each of the three days.
    assert_eq!(left.len(), 5 + 5 + 3, "{left:?}");
    assert!(left.last().unwrap().contains(&stamp(now)));
    assert!(!left
        .iter()
        .any(|f| f.contains(&stamp(now - KEEP_FOR_SECS - day))));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn pruning_keeps_five_however_old_and_everything_recent() {
    let dir = std::env::temp_dir().join(format!("tmuxy-prune-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let now = 1_759_622_400u64;
    let old = now - KEEP_FOR_SECS - 10;
    for i in 0..8u64 {
        std::fs::write(dir.join(snapshot_file_name("s", old + i)), "{}").unwrap();
    }
    std::fs::write(dir.join(snapshot_file_name("s", now)), "{}").unwrap();
    prune(&dir, "s", now);
    let left = dated_files(&dir, "s");
    assert_eq!(left.len(), KEEP_AT_LEAST, "{left:?}");
    assert!(left.last().unwrap().to_str().unwrap().contains(&stamp(now)));
    let _ = std::fs::remove_dir_all(&dir);
}
