//! Where a pane's shell prompts are, read from tmux.
//!
//! A shell with OSC 133 integration marks the line each prompt starts on
//! (`A`) and the line each command's output starts on (`C`), and tmux (3.4
//! and later) keeps both marks on the line as it scrolls into the history.
//! tmux has no format and no `capture-pane` flag for them: the only thing
//! that finds one is copy mode's `previous-prompt` / `next-prompt`.
//!
//! So the marks are read by walking. One command list enters copy mode on
//! the pane, steps from the bottom of the history up, prints where the
//! cursor is after each step, and leaves. tmux runs a command list in one
//! go, before it draws anything or tells any client that a pane's mode
//! changed, so by the time anyone looks the pane is as it was: no client,
//! tmuxy's own included, sees the mode. On a tmux older than 3.4 the cursor
//! never moves, and the pane reads as having no marks.
//!
//! Leaving is `scroll-down` at the bottom of a mode entered with `-e`, which
//! tmux then leaves by itself. A pane the user already had in copy mode was
//! not entered by this list (entering twice changes nothing), so it stays in
//! its mode, where a `cancel` would have ended theirs.
//!
//! This file is the whole of where prompt positions come from. What it
//! answers is rows counted from the top of the history, like the client's
//! scrollback rows, and nothing outside it knows how they were found.

use std::ops::Range;

use crate::control_mode::{ask, query, MonitorCommandSender};
use crate::{CommandError, PaneId};

/// Steps of the first walk. A pane whose shell marks nothing is the common
/// case, and one step says so.
const PROBE_STEPS: usize = 4;
/// Steps of the second walk, taken when the first did not reach the oldest
/// prompt: the most prompts a pane is read for, newest first.
const FULL_STEPS: usize = 256;
/// How often the last output is read again when the pane printed in between.
const CAPTURE_TRIES: usize = 3;

/// Where copy mode's cursor is: its row on screen, and how far the screen is
/// scrolled up from the bottom.
const POSITION: &str = "#{copy_cursor_y} #{scroll_position}";

/// A pane's prompt rows, oldest first, with the history size they were read
/// at. Row 0 is the oldest line of the history, so a row still names its
/// line after the pane prints more.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptMarks {
    pub history_size: u32,
    pub prompts: Vec<u32>,
}

/// What the newest command printed: `None` when the pane has no output mark
/// (no shell integration, or a tmux that keeps none), empty when the command
/// printed nothing.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct LastOutput {
    pub text: Option<String>,
}

/// The command list of one walk: the pane's size, into copy mode, the three
/// readings the walk starts from, `steps` steps up, and out.
fn walk_command(pane: &PaneId, steps: usize) -> String {
    let key = |command: &str| format!("send-keys -X -t {pane} {command}");
    let say = |format: &str| format!("display-message -p -t {pane} '{format}'");
    let mut list = vec![
        say("#{history_size} #{pane_height} #{pane_in_mode}"),
        format!("copy-mode -e -t {pane}"),
        // The mode works on its own copy of the history: its length is how
        // far up the top is.
        key("history-top"),
        say(POSITION),
        // A step looks above the cursor only, so a mark on the last row is
        // asked for from the row before it.
        key("history-bottom"),
        key("cursor-up"),
        key("next-prompt"),
        say(POSITION),
        key("history-bottom"),
        key("cursor-up"),
        key("next-prompt -o"),
        say(POSITION),
        key("history-bottom"),
        key("previous-prompt -o"),
        say(POSITION),
        key("history-bottom"),
    ];
    for _ in 0..steps {
        list.push(key("previous-prompt"));
        list.push(say(POSITION));
    }
    list.push(key("history-bottom"));
    list.push(key("scroll-down"));
    list.join(" ; ")
}

/// What one walk found.
#[derive(Debug, PartialEq)]
struct Walk {
    /// The pane's history size when the list ran.
    history_size: u32,
    /// The last row of the screen.
    bottom: u32,
    /// Prompt rows, newest first.
    prompts: Vec<u32>,
    /// The row the newest command's output starts on.
    output: Option<u32>,
    /// The walk reached the oldest prompt before it ran out of steps.
    complete: bool,
}

impl Walk {
    /// The rows the newest command printed: from its output mark to the line
    /// before the next prompt, or to the bottom while it still runs. A
    /// prompt on the output's own row is a command that printed nothing.
    fn last_output(&self) -> Option<Range<u32>> {
        let start = self.output?;
        let next = self.prompts.iter().copied().filter(|row| *row >= start);
        Some(start..next.min().unwrap_or(self.bottom + 1))
    }
}

/// The first `N` numbers of a line tmux printed.
fn numbers<const N: usize>(line: &str) -> Option<[u32; N]> {
    let mut fields = line.split_whitespace().map(str::parse::<u32>);
    let mut found = [0; N];
    for slot in &mut found {
        *slot = fields.next()?.ok()?;
    }
    Some(found)
}

fn read_walk(reply: &str) -> Option<Walk> {
    let mut lines = reply.lines();
    let [history_size, height, _] = numbers(lines.next()?)?;
    let [_, copied] = numbers(lines.next()?)?;
    let row = |line: &str| {
        let [on_screen, scrolled_up] = numbers(line)?;
        (copied + on_screen).checked_sub(scrolled_up)
    };
    let bottom = (copied + height).checked_sub(1)?;
    // On a one-row pane with no history the cursor has no row to go up to,
    // and stays on the bottom whether or not that row is marked.
    let on_bottom = |line: &str| Some(bottom > 0 && row(line)? == bottom);
    let prompt_on_bottom = on_bottom(lines.next()?)?;
    let output_on_bottom = on_bottom(lines.next()?)?;
    let output_above = row(lines.next()?)?;

    let mut prompts = Vec::from_iter(prompt_on_bottom.then_some(bottom));
    let mut at = bottom;
    let mut complete = false;
    for line in lines {
        let found = row(line)?;
        // A step that finds nothing leaves the cursor where it was.
        if found == at {
            complete = true;
            break;
        }
        prompts.push(found);
        at = found;
    }
    Some(Walk {
        history_size,
        bottom,
        prompts,
        output: if output_on_bottom {
            Some(bottom)
        } else {
            (output_above != bottom).then_some(output_above)
        },
        complete,
    })
}

/// Whether a walk that failed had put the pane in copy mode: its first line
/// says the pane was in no mode, and a later one was printed from inside.
fn left_in_mode(printed: &str) -> bool {
    let mut lines = printed.lines();
    matches!(lines.next().and_then(numbers), Some([_, _, 0])) && lines.next().is_some()
}

async fn walk(
    tx: &MonitorCommandSender,
    pane: &PaneId,
    steps: usize,
) -> Result<Walk, CommandError> {
    let reply = ask(tx, &walk_command(pane, steps)).await?;
    if let Some(error) = reply.error {
        // tmux stops a list at its first failure, so the commands that
        // leave the mode never ran.
        if left_in_mode(&reply.output) {
            let _ = query(tx, &format!("send-keys -X -t {pane} cancel")).await;
        }
        return Err(CommandError::tmux(error).context("Failed to read prompt marks"));
    }
    read_walk(&reply.output).ok_or_else(|| {
        CommandError::tmux(format!(
            "Failed to parse prompt marks from tmux: {:?}",
            reply.output.lines().next().unwrap_or_default()
        ))
    })
}

/// The probe, then the long walk when the probe did not reach the top.
async fn read(tx: &MonitorCommandSender, pane: &PaneId) -> Result<Walk, CommandError> {
    let probe = walk(tx, pane, PROBE_STEPS).await?;
    if probe.complete {
        return Ok(probe);
    }
    walk(tx, pane, FULL_STEPS).await
}

/// The pane's prompts: the newest [`FULL_STEPS`] of them at most.
pub async fn prompt_marks(
    tx: &MonitorCommandSender,
    pane: &PaneId,
) -> Result<PromptMarks, CommandError> {
    let walk = read(tx, pane).await?;
    Ok(PromptMarks {
        history_size: walk.history_size,
        prompts: walk.prompts.into_iter().rev().collect(),
    })
}

/// The text the pane's newest command printed, wrapped lines joined.
///
/// The rows are found by one query and captured by the next, and
/// `capture-pane` counts lines from the top of the screen: a pane that
/// printed in between has moved them, which its history size shows. The
/// capture is then thrown away and both are asked again.
pub async fn last_command_output(
    tx: &MonitorCommandSender,
    pane: &PaneId,
) -> Result<LastOutput, CommandError> {
    for _ in 0..CAPTURE_TRIES {
        let walk = read(tx, pane).await?;
        let Some(rows) = walk.last_output() else {
            return Ok(LastOutput { text: None });
        };
        if rows.is_empty() {
            return Ok(LastOutput {
                text: Some(String::new()),
            });
        }
        let line = |row: u32| i64::from(row) - i64::from(walk.history_size);
        let (first, last) = (line(rows.start), line(rows.end - 1));
        let printed = query(
            tx,
            &format!(
                "display-message -p -t {pane} '#{{history_size}}' ; \
                 capture-pane -p -J -t {pane} -S {first} -E {last}"
            ),
        )
        .await
        .map_err(|e| e.context("Failed to capture the last output"))?;
        let (size, text) = printed.split_once('\n').unwrap_or((printed.as_str(), ""));
        if size.trim().parse() == Ok(walk.history_size) {
            return Ok(LastOutput {
                text: Some(tidy(text)),
            });
        }
    }
    Err(CommandError::unavailable(
        "The pane kept printing while its last output was read",
    ))
}

/// The captured rows without the padding tmux keeps at the end of each line
/// and without the blank rows below the last one printed.
fn tidy(captured: &str) -> String {
    let lines: Vec<&str> = captured.lines().map(str::trim_end).collect();
    let end = lines
        .iter()
        .rposition(|line| !line.is_empty())
        .map_or(0, |last| last + 1);
    lines[..end].join("\n")
}

#[cfg(test)]
#[path = "prompt_marks_tests.rs"]
mod tests;
