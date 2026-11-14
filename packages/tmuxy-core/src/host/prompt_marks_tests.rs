#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use super::*;
use crate::control_mode::{CommandReply, MonitorCommand};

type Asked = Arc<Mutex<Vec<String>>>;

/// A monitor that answers each query with the next of `replies`, and keeps
/// what it was asked.
fn answering(replies: Vec<Result<&str, (&str, &str)>>) -> (MonitorCommandSender, Asked) {
    let (tx, mut rx) = tokio::sync::mpsc::channel(8);
    let asked: Asked = Arc::default();
    let seen = Arc::clone(&asked);
    let mut replies: VecDeque<CommandReply> = replies
        .into_iter()
        .map(|reply| match reply {
            Ok(output) => CommandReply {
                output: output.to_string(),
                error: None,
            },
            Err((output, error)) => CommandReply {
                output: output.to_string(),
                error: Some(error.to_string()),
            },
        })
        .collect();
    tokio::spawn(async move {
        while let Some(cmd) = rx.recv().await {
            if let MonitorCommand::RunCommandWithReply { command, reply } = cmd {
                seen.lock().unwrap().push(command);
                let _ = reply.send(replies.pop_front().expect("a reply for every query"));
            }
        }
    });
    (tx, asked)
}

fn pane() -> PaneId {
    PaneId::from_number(3)
}

/// A 24-row pane with 100 lines of history: prompts on rows 90, 110 and the
/// last row (123), the newest command's output from row 111.
const THREE_PROMPTS: &str = "100 24 0\n0 100\n23 0\n22 0 last\n11 0 one\n10 0\n0 10\n0 10\n0 10";

/// What a pane in no mode answers when asked where its copy mode is.
const NO_MODE: &str = ",0,,,";

/// The same pane with no marks: no step moves the cursor.
const NO_MARKS: &str = "100 24 0\n0 100\n22 0\n22 0\n23 0\n23 0\n23 0\n23 0\n23 0";

#[test]
fn a_walk_enters_with_e_steps_up_and_leaves_by_scrolling_down() {
    let list = walk_command(&pane(), 2);
    let commands: Vec<&str> = list.split(" ; ").collect();
    assert_eq!(
        commands[0],
        "display-message -p -t %3 '#{history_size} #{pane_height} #{pane_in_mode}'"
    );
    assert_eq!(commands[1], "copy-mode -e -t %3");
    assert_eq!(
        commands
            .iter()
            .filter(|c| **c == "send-keys -X -t %3 previous-prompt")
            .count(),
        2
    );
    assert_eq!(
        commands[commands.len() - 2..],
        [
            "send-keys -X -t %3 history-bottom",
            "send-keys -X -t %3 scroll-down"
        ],
        "a mode this list entered ends there; one the user was in does not"
    );
    assert!(!list.contains("cancel"));
}

#[test]
fn rows_are_counted_from_the_top_of_the_history() {
    let walk = read_walk(THREE_PROMPTS).unwrap();
    assert_eq!(
        walk,
        Walk {
            history_size: 100,
            bottom: 123,
            prompts: vec![123, 110, 90],
            output: Some(111),
            output_row: "one".to_string(),
            complete: true,
        }
    );
}

#[test]
fn a_pane_whose_shell_marks_nothing_has_no_rows() {
    let walk = read_walk(NO_MARKS).unwrap();
    assert_eq!(walk.prompts, Vec::<u32>::new());
    assert_eq!(walk.output, None);
    assert!(walk.complete);
    assert_eq!(walk.last_output(), None);
}

#[test]
fn a_walk_that_ran_out_of_steps_says_so() {
    let walk = read_walk("100 24 0\n0 100\n22 0\n22 0\n23 0\n10 0\n0 10").unwrap();
    assert_eq!(walk.prompts, vec![110, 90]);
    assert!(!walk.complete, "the last step still found a prompt");
}

#[test]
fn a_one_row_pane_with_no_history_has_no_mark_on_its_only_row() {
    let walk = read_walk("0 1 0\n0 0\n0 0\n0 0\n0 0\n0 0").unwrap();
    assert_eq!(walk.prompts, Vec::<u32>::new());
    assert_eq!(walk.output, None);
}

/// The mode a user is already in keeps its own copy of the history, taken
/// when they entered: rows are counted in it, not in the pane's history now.
#[test]
fn a_pane_already_in_copy_mode_is_read_from_the_history_its_mode_holds() {
    let walk = read_walk("140 24 1\n0 100\n23 0\n22 0\n11 0\n10 0\n10 0").unwrap();
    assert_eq!(walk.history_size, 140);
    assert_eq!(walk.bottom, 123);
    assert_eq!(walk.prompts, vec![123, 110]);
    assert_eq!(walk.output, Some(111));
}

#[test]
fn a_reply_that_is_not_the_walks_is_refused() {
    assert_eq!(read_walk(""), None);
    assert_eq!(read_walk("100 24 0"), None);
    assert_eq!(read_walk("100 24 0\n0 100\nnope"), None);
    assert_eq!(
        read_walk("100 24 0\n0 100\n23 0\n22 0\n0 500\n10 0"),
        None,
        "scrolled further up than the history is long"
    );
}

fn walk_with(prompts: &[u32], output: Option<u32>) -> Walk {
    Walk {
        history_size: 100,
        bottom: 123,
        prompts: prompts.to_vec(),
        output,
        output_row: String::new(),
        complete: true,
    }
}

#[test]
fn the_last_output_ends_before_the_prompt_that_followed_it() {
    assert_eq!(
        walk_with(&[123, 110, 90], Some(111)).last_output(),
        Some(111..123)
    );
    assert_eq!(
        walk_with(&[123, 120, 110], Some(111)).last_output(),
        Some(111..120),
        "an empty line entered at the prompt does not lengthen it"
    );
}

#[test]
fn a_command_still_running_has_printed_down_to_the_bottom() {
    assert_eq!(
        walk_with(&[110, 90], Some(111)).last_output(),
        Some(111..124)
    );
}

#[test]
fn a_prompt_on_the_outputs_own_row_is_a_command_that_printed_nothing() {
    let rows = walk_with(&[123, 111, 110], Some(111))
        .last_output()
        .unwrap();
    assert!(rows.is_empty());
}

#[test]
fn captured_rows_lose_their_padding_and_the_blank_rows_below() {
    assert_eq!(tidy("one  \n\n  two\n   \n\n"), "one\n\n  two");
    assert_eq!(tidy("\n\n"), "");
}

#[tokio::test]
async fn prompts_are_answered_oldest_first_from_one_short_walk() {
    let (tx, asked) = answering(vec![Ok(NO_MODE), Ok(THREE_PROMPTS)]);
    let marks = prompt_marks(&tx, &pane()).await.unwrap();
    assert_eq!(
        marks,
        PromptMarks {
            history_size: 100,
            prompts: vec![90, 110, 123],
        }
    );
    let asked = asked.lock().unwrap();
    assert_eq!(asked.len(), 2, "the probe reached the top");
    assert!(asked[0].contains("#{pane_mode},#{selection_present}"));
}

#[tokio::test]
async fn a_pane_with_more_prompts_than_the_probe_steps_is_walked_again_at_length() {
    let probe = "100 24 0\n0 100\n22 0\n22 0\n23 0\n20 0\n15 0\n10 0\n5 0";
    let long = "100 24 0\n0 100\n22 0\n22 0\n23 0\n20 0\n15 0\n10 0\n5 0\n0 0\n0 0";
    let (tx, asked) = answering(vec![Ok(NO_MODE), Ok(probe), Ok(long)]);
    let marks = prompt_marks(&tx, &pane()).await.unwrap();
    assert_eq!(marks.prompts, vec![100, 105, 110, 115, 120]);
    let asked = asked.lock().unwrap();
    let steps = |list: &String| list.matches("-X -t %3 previous-prompt ;").count();
    assert_eq!(
        (steps(&asked[1]), steps(&asked[2])),
        (PROBE_STEPS, FULL_STEPS)
    );
}

#[tokio::test]
async fn a_walk_tmux_stopped_half_way_takes_the_pane_out_of_the_mode_it_entered() {
    let (tx, asked) = answering(vec![Ok(NO_MODE), Err(("100 24 0\n0 100", "boom")), Ok("")]);
    let error = prompt_marks(&tx, &pane()).await.unwrap_err();
    assert_eq!(error.kind, crate::ErrorKind::Tmux);
    assert_eq!(asked.lock().unwrap()[2], "send-keys -X -t %3 cancel");
}

#[tokio::test]
async fn a_walk_that_failed_before_entering_or_in_the_users_own_mode_cancels_nothing() {
    for printed in ["", "100 24 0", "100 24 1\n0 100"] {
        let (tx, asked) = answering(vec![Ok(NO_MODE), Err((printed, "boom"))]);
        assert!(prompt_marks(&tx, &pane()).await.is_err());
        assert_eq!(asked.lock().unwrap().len(), 2, "after {printed:?}");
    }
}

#[tokio::test]
async fn the_last_output_is_captured_by_its_rows_from_the_top_of_the_screen() {
    let (tx, asked) = answering(vec![
        Ok(NO_MODE),
        Ok(THREE_PROMPTS),
        Ok("100\none  \ntwo\n\n"),
    ]);
    let output = last_command_output(&tx, &pane()).await.unwrap();
    assert_eq!(output.text.as_deref(), Some("one\ntwo"));
    let asked = asked.lock().unwrap();
    assert!(
        asked[2].ends_with("capture-pane -p -J -t %3 -S 11 -E 22"),
        "{}",
        asked[2]
    );
}

#[tokio::test]
async fn a_pane_that_printed_between_the_walk_and_the_capture_is_read_again() {
    let moved = "101 24 0\n0 101\n23 0\n22 0\n11 0 one\n10 0\n10 0\n10 0\n10 0\n10 0";
    let (tx, asked) = answering(vec![
        Ok(NO_MODE),
        Ok(THREE_PROMPTS),
        Ok("101\none stale"),
        Ok(NO_MODE),
        Ok(moved),
        Ok("101\none fresh"),
    ]);
    let output = last_command_output(&tx, &pane()).await.unwrap();
    assert_eq!(output.text.as_deref(), Some("one fresh"));
    assert_eq!(asked.lock().unwrap().len(), 6);
}

/// A full history keeps its size while every line in it moves up: only the
/// text says the rows are no longer the ones the walk named.
#[tokio::test]
async fn a_capture_whose_first_row_is_not_the_one_the_walk_read_is_taken_again() {
    let (tx, asked) = answering(vec![
        Ok(NO_MODE),
        Ok(THREE_PROMPTS),
        Ok("100\ntwo\n$ next"),
        Ok(NO_MODE),
        Ok(THREE_PROMPTS),
        Ok("100\none\ntwo"),
    ]);
    let output = last_command_output(&tx, &pane()).await.unwrap();
    assert_eq!(output.text.as_deref(), Some("one\ntwo"));
    assert_eq!(asked.lock().unwrap().len(), 6);
}

#[tokio::test]
async fn an_output_too_long_to_copy_at_once_is_refused_before_it_is_captured() {
    // The newest output starts on row 1,000 of 30,024 and no prompt follows it.
    let huge = "30000 24 0\n0 30000\n22 0\n22 0\n0 29000 start\n23 0\n23 0\n23 0\n23 0";
    let (tx, asked) = answering(vec![Ok(NO_MODE), Ok(huge)]);
    let error = last_command_output(&tx, &pane()).await.unwrap_err();
    assert_eq!(error.kind, crate::ErrorKind::Unavailable);
    assert!(error.to_string().contains("29024 lines"), "{error}");
    assert_eq!(asked.lock().unwrap().len(), 2);
}

#[tokio::test]
async fn a_pane_that_never_holds_still_is_given_up_on() {
    let (tx, _) = answering(vec![
        Ok(NO_MODE),
        Ok(THREE_PROMPTS),
        Ok("101\none"),
        Ok(NO_MODE),
        Ok(THREE_PROMPTS),
        Ok("102\none"),
        Ok(NO_MODE),
        Ok(THREE_PROMPTS),
        Ok("103\none"),
    ]);
    let error = last_command_output(&tx, &pane()).await.unwrap_err();
    assert_eq!(error.kind, crate::ErrorKind::Unavailable);
}

#[tokio::test]
async fn no_output_mark_is_no_text_and_a_command_that_printed_nothing_is_empty_text() {
    let (tx, _) = answering(vec![Ok(NO_MODE), Ok(NO_MARKS)]);
    assert_eq!(last_command_output(&tx, &pane()).await.unwrap().text, None);

    // The output mark and the newest prompt are both on the last row.
    let silent = "100 24 0\n0 100\n23 0\n23 0\n23 0\n10 0\n10 0\n10 0\n10 0";
    let (tx, asked) = answering(vec![Ok(NO_MODE), Ok(silent)]);
    assert_eq!(
        last_command_output(&tx, &pane()).await.unwrap().text,
        Some(String::new())
    );
    assert_eq!(asked.lock().unwrap().len(), 2, "nothing to capture");
}

#[test]
fn only_the_users_own_copy_mode_is_one_to_put_back() {
    assert_eq!(read_before(NO_MODE), Before::NoCopyMode);
    assert_eq!(read_before(""), Before::NoCopyMode);
    assert_eq!(
        read_before("tree-mode,0,,,"),
        Before::NoCopyMode,
        "the walk enters its own mode over another kind, and leaves it"
    );
    assert_eq!(
        read_before("copy-mode,0,12,3,5\n"),
        Before::CopyMode {
            scrolled_up: 12,
            x: 3,
            y: 5
        }
    );
    assert_eq!(read_before("copy-mode,1,12,3,5"), Before::Selecting);
}

#[test]
fn a_cursor_is_put_back_from_the_top_left() {
    assert_eq!(
        restore_command(&pane(), 12, 3, 5),
        "send-keys -X -t %3 history-top ; send-keys -X -t %3 goto-line 12 ; \
         send-keys -N 5 -X -t %3 cursor-down ; send-keys -N 3 -X -t %3 cursor-right"
    );
    assert_eq!(
        restore_command(&pane(), 0, 0, 0),
        "send-keys -X -t %3 history-top ; send-keys -X -t %3 goto-line 0"
    );
}

#[tokio::test]
async fn a_copy_mode_the_user_is_in_gets_its_cursor_back_after_the_walk() {
    let in_mode = "100 24 1\n0 100\n23 0\n22 0\n11 0 one\n10 0\n10 0\n10 0\n10 0";
    let (tx, asked) = answering(vec![Ok("copy-mode,0,12,3,5"), Ok(in_mode), Ok("")]);
    let marks = prompt_marks(&tx, &pane()).await.unwrap();
    assert_eq!(marks.prompts, vec![110, 123]);
    let asked = asked.lock().unwrap();
    assert_eq!(asked[2], restore_command(&pane(), 12, 3, 5));
}

#[tokio::test]
async fn a_copy_mode_with_a_selection_begun_is_not_walked() {
    let (tx, asked) = answering(vec![Ok("copy-mode,1,12,3,5")]);
    let error = prompt_marks(&tx, &pane()).await.unwrap_err();
    assert_eq!(error.kind, crate::ErrorKind::Unavailable);
    assert_eq!(asked.lock().unwrap().len(), 1, "the steps would drag it");
}
