//! `tmuxy agent start <label>`: `agent spawn`, returning once the agent is
//! ready rather than as soon as its pane exists.
//!
//! Ready means the pane has a state: an agent with tmuxy's hooks sets one
//! when its session starts, an agent without hooks gets one from the screen
//! rules, and a program can declare its own (`tmuxy pane state`, OSC 7501).
//! An orchestrator can then hand it work, or `agent wait` on it, knowing it
//! is up. The label is the agent's name for as long as its pane lives.

use std::time::{Duration, Instant};

use tmuxy_core::constants::tmux_options;

use super::spawn::{self, SpawnArgs};
use crate::cli_json::{self, Answer, EXIT_FAILED, EXIT_USAGE};

/// How often the pane is read while the agent starts.
const POLL: Duration = Duration::from_millis(250);

#[derive(clap::Args, Debug)]
pub struct StartArgs {
    /// The agent's name: its pane's label, for `agent wait`, `-t` and the
    /// tree. Must be unused.
    #[arg(value_name = "LABEL")]
    alias: String,
    /// Give up after this long (30s, 10m); the agent keeps running.
    #[arg(long = "for", default_value = "60s")]
    limit: String,
    #[command(flatten)]
    spawn: SpawnArgs,
}

/// What a read of the starting pane says.
#[derive(Debug, PartialEq, Eq)]
pub enum Readiness {
    /// It has a state: ready.
    Ready(String),
    /// No pane answers: the agent exited.
    Gone,
    Starting,
}

/// The readiness of `pane` from a read of [`state_format`]: `None` when
/// tmux refused the read. `display-message -t` falls back to another pane
/// when its target is gone, so the read names its pane, and a different one
/// (or a dead one) means the agent exited.
pub fn readiness(pane: &str, read: Option<&str>) -> Readiness {
    let Some(read) = read else {
        return Readiness::Gone;
    };
    let mut fields = read.trim_end_matches('\n').splitn(3, '\t');
    let (Some(id), Some(dead), Some(state)) = (fields.next(), fields.next(), fields.next()) else {
        return Readiness::Gone;
    };
    if id != pane || dead == "1" {
        return Readiness::Gone;
    }
    match state.trim() {
        "" => Readiness::Starting,
        state => Readiness::Ready(state.to_string()),
    }
}

/// The pane's id, whether it is dead, and its state.
fn state_format() -> String {
    format!(
        "#{{pane_id}}\t#{{pane_dead}}\t#{{{}}}",
        tmux_options::PANE_STATE
    )
}

fn read_state(pane: &str) -> Option<String> {
    let read = ["display-message", "-p", "-t", pane, &state_format()].map(String::from);
    tmuxy_core::session::tmux_output(&read).ok()
}

pub fn run(answer: &Answer, mut args: StartArgs) {
    if args.spawn.label.is_some() {
        answer.exit(
            EXIT_USAGE,
            "the label is start's first argument, not --label",
        );
    }
    let Some(limit) = super::wait::duration(&args.limit) else {
        answer.exit(EXIT_USAGE, "--for takes a duration: 30s, 10m, 2h")
    };
    args.spawn.label = Some(args.alias.clone());
    let gone = |alias: &str| -> ! {
        answer.exit(EXIT_FAILED, &format!("{alias} exited before it was ready"))
    };
    let Some(spawned) = spawn::spawn(answer, &args.spawn) else {
        gone(&args.alias)
    };
    let deadline = Instant::now() + limit;
    let state = loop {
        match readiness(&spawned.pane, read_state(&spawned.pane).as_deref()) {
            Readiness::Ready(state) => break state,
            Readiness::Gone => gone(&args.alias),
            Readiness::Starting if Instant::now() >= deadline => answer.exit(
                EXIT_FAILED,
                &format!(
                    "{} was not ready within {}; it is still running in {}",
                    args.alias, args.limit, spawned.pane
                ),
            ),
            Readiness::Starting => std::thread::sleep(POLL),
        }
    };
    answer.done(
        &[
            ("paneId", cli_json::string(&spawned.pane)),
            ("label", cli_json::string(&args.alias)),
            ("agent", cli_json::string(&spawned.agent)),
            ("state", cli_json::string(&state)),
        ],
        &format!("{} {} {state}", spawned.pane, args.alias),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_pane_with_a_state_is_ready_and_one_that_is_gone_exited() {
        let read = |line: &str| readiness("%5", Some(line));
        assert_eq!(read("%5\t0\tidle\n"), Readiness::Ready("idle".into()));
        assert_eq!(read("%5\t0\t\n"), Readiness::Starting);
        assert_eq!(readiness("%5", None), Readiness::Gone);
        assert_eq!(read("%5\t1\t\n"), Readiness::Gone, "a dead pane");
        // display-message fell back to another pane: %5 is gone.
        assert_eq!(read("%2\t0\tidle\n"), Readiness::Gone);
        assert_eq!(read("garbage"), Readiness::Gone);
    }
}
