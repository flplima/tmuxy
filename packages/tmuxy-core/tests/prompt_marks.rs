//! A pane's shell prompts are read from tmux without the pane ever being
//! seen in copy mode.
//!
//! tmux keeps a shell's OSC 133 marks on the lines they were printed on,
//! and only copy mode's `previous-prompt` finds them. The host reads them
//! with one command list that enters the mode, walks and leaves
//! (`tmuxy-core/src/host/prompt_marks.rs`). What that relies on is tmux's
//! own behaviour, so it is held here against a real one: the rows it
//! answers are the rows the prompts are on, and no state the monitor emits
//! has the pane in a mode.
//!
//! Needs a `tmux` binary; the socket name is unique per process.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::time::Duration;

use tmuxy_core::host::{last_command_output, prompt_marks};
use tmuxy_core::StateUpdate;

mod common;

/// Forty commands under a marked prompt each: the first prints far more
/// than a window is tall, the second prints nothing, and the last prompt is
/// left waiting on the bottom row.
const SHELL: &str = r#"
run() {
  printf '\033]133;A\033\\PROMPT%s$ cmd\n\033]133;C\033\\' "$1"
  i=1; while [ "$i" -le "$2" ]; do echo "OUT$1_$i"; i=$((i+1)); done
  printf '\033]133;D;0\033\\'
}
run 1 300; run 2 0
n=3; while [ "$n" -le 39 ]; do run "$n" 2; n=$((n+1)); done
run 40 3
printf '\033]133;A\033\\PROMPTEND$ '
sleep 60
"#;

/// tmux 3.4 is the first that keeps prompt marks. `tmux -V` says `tmux 3.6`,
/// `tmux 3.2a` or `tmux next-3.9`.
fn tmux_keeps_prompt_marks() -> bool {
    let version = common::tmux(&["-V"]).unwrap_or_default();
    let numbers: String = version
        .chars()
        .skip_while(|c| !c.is_ascii_digit())
        .take_while(|c| c.is_ascii_digit() || *c == '.')
        .collect();
    let mut parts = numbers
        .split('.')
        .map(|part| part.parse::<u32>().unwrap_or(0));
    let version = (parts.next().unwrap_or(0), parts.next().unwrap_or(0));
    version >= (3, 4)
}

fn pane_was_seen_in_a_mode(updates: &[StateUpdate]) -> bool {
    updates.iter().any(|update| match update {
        StateUpdate::Full { state } => state.panes.iter().any(|pane| pane.in_mode),
        StateUpdate::Delta { delta } => serde_json::to_string(delta)
            .unwrap()
            .contains("\"in_mode\":true"),
    })
}

#[tokio::test]
async fn prompt_rows_and_the_last_output_are_read_without_the_pane_showing_a_mode() {
    let server = common::ScratchServer::process_wide("prompt-marks");
    common::tmux(&[
        "new-session",
        "-d",
        "-s",
        "app",
        "-x",
        "80",
        "-y",
        "24",
        SHELL,
    ])
    .unwrap();
    common::wait_until("the last prompt", Duration::from_secs(20), || async {
        common::tmux(&["capture-pane", "-p", "-t", "app"]).is_ok_and(|s| s.contains("PROMPTEND"))
    })
    .await;

    let monitor = server.attach("app", false).await;
    let pane = monitor.state().await.panes[0].tmux_id.clone();
    let emitted_before = monitor.recorder.updates.lock().unwrap().len();

    let marks = prompt_marks(&monitor.tx, &pane).await.unwrap();
    let output = last_command_output(&monitor.tx, &pane).await.unwrap();

    if !tmux_keeps_prompt_marks() {
        assert_eq!(marks.prompts, Vec::<u32>::new());
        assert_eq!(output.text, None);
        return;
    }

    // Every line of the pane, the history's oldest first: row N is line N.
    let lines = common::tmux(&["capture-pane", "-p", "-t", "app", "-S", "-", "-E", "-"]).unwrap();
    let lines: Vec<&str> = lines.lines().collect();
    let prompt_lines: Vec<u32> = (0u32..)
        .zip(&lines)
        .filter(|(_, line)| line.starts_with("PROMPT"))
        .map(|(row, _)| row)
        .collect();
    assert_eq!(prompt_lines.len(), 41, "the scene: {lines:?}");
    assert_eq!(
        marks.prompts, prompt_lines,
        "every prompt, the one on the last row included, by its row from the top of the history"
    );
    assert_eq!(
        output.text.as_deref(),
        Some("OUT40_1\nOUT40_2\nOUT40_3"),
        "the newest command's output, without the prompt that followed it"
    );

    // tmux tells a control client of a mode change after the list that made
    // it; the listing that follows is what would have shown it.
    tokio::time::sleep(Duration::from_millis(500)).await;
    let state = monitor.state().await;
    assert!(!state.panes[0].in_mode, "the walk left the mode it entered");
    assert!(
        !pane_was_seen_in_a_mode(&monitor.recorder.updates.lock().unwrap()[emitted_before..]),
        "no state the monitor emitted had the pane in a mode"
    );

    // A pane the user put in copy mode stays in it.
    monitor.ask(&format!("copy-mode -t {pane}")).await;
    let again = prompt_marks(&monitor.tx, &pane).await.unwrap();
    assert_eq!(again.prompts, prompt_lines);
    let mode = monitor
        .ask(&format!("display-message -p -t {pane} '#{{pane_in_mode}}'"))
        .await;
    assert_eq!(mode.output.trim(), "1", "their copy mode is not ended");
    assert_eq!(monitor.errors(), Vec::<String>::new());
}
