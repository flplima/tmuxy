//! `tmuxy pane send --wait`: after the keys go in, wait for the agent in the
//! pane to take them up and finish. An agent that does not start working
//! within a few seconds has "stalled" (the keys may have landed in a
//! half-typed line, or the agent has no hooks to say so); one that stops at
//! a prompt is reported, never answered. The wait is pinned to the program
//! that was in front when the keys went in, so another one started in its
//! place cannot end it.
//!
//! The states are the ones the agents' hooks write (`tmuxy agent install`,
//! `@tmuxy-pane-state`): a pane with no hooks never says `working`, and a
//! wait on it stalls. For a command in a shell, `tmuxy pane run --wait` is
//! the wait.

use std::time::Duration;

use tmuxy_core::ask;
use tmuxy_core::constants::tmux_options::PANE_STATE;
use tmuxy_core::{PaneId, PaneStateName};

use crate::cli_json::{EXIT_FAILED, EXIT_TARGET, EXIT_USAGE};

const POLL: Duration = Duration::from_millis(250);

/// How long a wait goes on: the agent must start working within `stall`,
/// and finish within `limit` of the keys going in.
#[derive(Debug, Clone, Copy)]
pub(super) struct Wait {
    pub stall: Duration,
    pub limit: Duration,
}

/// The program in front in a pane: tmux's process for the pane, the command
/// tmux sees in front, and when the terminal's foreground process started
/// (where `ps` can say). Another program in the pane is another occupant.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Occupant {
    pid: String,
    command: String,
    started: String,
}

pub(super) async fn occupant<T: ask::Tmux>(
    tmux: &T,
    pane: &PaneId,
) -> Result<Occupant, (i32, String)> {
    let argv = [
        "display-message",
        "-p",
        "-t",
        pane.as_str(),
        "#{pane_pid}\t#{pane_current_command}",
    ];
    let line = ask::Tmux::read(tmux, argv.map(String::from).to_vec())
        .await
        .map_err(|_| (EXIT_TARGET, format!("{pane} is gone")))?;
    let (pid, command) = line
        .trim_end()
        .split_once('\t')
        .unwrap_or((line.trim(), ""));
    Ok(Occupant {
        pid: pid.to_string(),
        command: command.to_string(),
        started: foreground_started(pid),
    })
}

/// When the foreground process of the terminal `pane_pid` runs on started,
/// as `ps` says it; empty where `ps` cannot say.
fn foreground_started(pane_pid: &str) -> String {
    let ps = |args: &[&str]| {
        std::process::Command::new("ps")
            .args(args)
            .env("LC_ALL", "C")
            .stdin(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .output()
            .ok()
            .filter(|out| out.status.success())
            .map(|out| String::from_utf8_lossy(&out.stdout).trim().to_string())
            .unwrap_or_default()
    };
    if pane_pid.parse::<u32>().is_err() {
        return String::new();
    }
    let group = ps(&["-o", "tpgid=", "-p", pane_pid]);
    if group.parse::<u32>().is_err() {
        return String::new();
    }
    ps(&["-o", "lstart=", "-p", &group])
}

/// Wait until the agent in `pane`, still `pinned`, has taken the keys up and
/// finished: `Ok` with the state it settled in.
pub(super) async fn settle<T: ask::Tmux>(
    tmux: &T,
    pane: &PaneId,
    pinned: &Occupant,
    wait: Wait,
) -> Result<String, (i32, String)> {
    let start = tokio::time::Instant::now();
    let mut working = false;
    loop {
        if occupant(tmux, pane).await? != *pinned {
            return Err((
                EXIT_FAILED,
                format!("the program in {pane} changed while waiting"),
            ));
        }
        let argv = [
            "display-message",
            "-p",
            "-t",
            pane.as_str(),
            &format!("#{{{PANE_STATE}}}"),
        ];
        let state = ask::Tmux::read(tmux, argv.map(String::from).to_vec())
            .await
            .map_err(|_| (EXIT_TARGET, format!("{pane} is gone")))?;
        match state.trim() {
            s if s == PaneStateName::Working.as_str() => working = true,
            s if s == PaneStateName::NeedsInput.as_str() => {
                return Err((
                    EXIT_FAILED,
                    format!("{pane} stopped at a prompt for the user; nothing answers it"),
                ));
            }
            s if s == PaneStateName::Error.as_str() => {
                return Err((EXIT_FAILED, format!("{pane} reports an error")));
            }
            s if working => {
                return Ok(if s.is_empty() {
                    "idle".into()
                } else {
                    s.to_string()
                });
            }
            _ => {}
        }
        let waited = start.elapsed();
        if !working && waited >= wait.stall {
            return Err((
                EXIT_FAILED,
                format!(
                    "stalled: {pane} did not start working within {}s",
                    wait.stall.as_secs()
                ),
            ));
        }
        if waited >= wait.limit {
            return Err((
                EXIT_FAILED,
                format!("{pane} is still working after {}s", wait.limit.as_secs()),
            ));
        }
        tmux.keep_alive().await;
        tokio::time::sleep(POLL).await;
    }
}

/// `30s`, `10m`, `2h`, or plain seconds, as `--wait-for` takes it.
pub(super) fn duration(text: &str) -> Result<Duration, (i32, String)> {
    let bad = || {
        (
            EXIT_USAGE,
            format!("not a duration: '{text}' (use 30s, 10m, 2h)"),
        )
    };
    let (number, scale) = match text.chars().last() {
        Some('s') => (&text[..text.len() - 1], 1),
        Some('m') => (&text[..text.len() - 1], 60),
        Some('h') => (&text[..text.len() - 1], 3600),
        _ => (text, 1),
    };
    let n: u64 = number.parse().map_err(|_| bad())?;
    if n == 0 {
        return Err(bad());
    }
    Ok(Duration::from_secs(n.checked_mul(scale).ok_or_else(bad)?))
}
