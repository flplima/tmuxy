//! `tmuxy agent wait`: wait for agents in panes to reach a state, read off
//! `@tmuxy-pane-state` (what their hooks, or a program's own report, set)
//! rather than off their screens. A collapsed row of a stack is one line tall
//! for tmux, so its screen says nothing; its state still does.
//!
//! A pane counts once its state changes to one the caller waits for: an
//! agent already idle when the wait begins (finished earlier, or not yet
//! given its task) does not end the wait at once. `--now` counts a pane that
//! is already there. A pane that is gone ends the wait with exit 3 unless
//! `--until exited` asked for that, so a script never reads a crashed or
//! closed pane as a finished one.
//!
//! What it cannot see: a state reached before its first read (an agent that
//! finished before the wait began), or one that came and went between two
//! reads. Both need the writers to stamp each change, which is not done
//! yet.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use crate::cli_json::{Answer, EXIT_FAILED, EXIT_NO_SERVER, EXIT_TARGET, EXIT_USAGE};

/// How often the panes' states are read: often at first, when a short turn
/// ends, then less, so a wait of hours costs little.
const POLL: Duration = Duration::from_millis(250);
const SLOW_POLL: Duration = Duration::from_secs(1);
const FAST_FOR: Duration = Duration::from_secs(10);

/// The listing a wait reads: every pane, its label and its state.
fn listing_format() -> String {
    use tmuxy_core::constants::tmux_options::{PANE_LABEL, PANE_STATE};
    format!("#{{pane_id}}\t#{{{PANE_LABEL}}}\t#{{{PANE_STATE}}}")
}

/// The states a wait can be for. `done` is a result to be seen (`unread`).
#[derive(clap::ValueEnum, Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Until {
    Idle,
    NeedsInput,
    Error,
    Done,
    /// The pane is gone.
    Exited,
}

impl Until {
    fn pane_state(self) -> &'static str {
        use tmuxy_core::PaneStateName;
        match self {
            Until::Idle => PaneStateName::Idle,
            Until::NeedsInput => PaneStateName::NeedsInput,
            Until::Error => PaneStateName::Error,
            Until::Done => PaneStateName::Unread,
            Until::Exited => return EXITED,
        }
        .as_str()
    }
}

/// What a gone pane counts as.
const EXITED: &str = "exited";

/// Every state but `working`: the agent has stopped and has something to say.
const SETTLED: [Until; 4] = [Until::Idle, Until::NeedsInput, Until::Error, Until::Done];

#[derive(clap::Args, Debug)]
pub struct WaitArgs {
    /// The panes: ids (`%5`) or labels (`pane run --label`, `agent spawn`).
    #[arg(required = true)]
    targets: Vec<String>,
    /// The states to wait for, comma-separated; default: any but working.
    /// A pane that goes away ends the wait with exit 3, unless `exited` is
    /// one of them.
    #[arg(long, value_enum, value_delimiter = ',')]
    until: Vec<Until>,
    /// Wait until every pane counts, not the first one.
    #[arg(long)]
    all: bool,
    /// Count a pane that is already in a wanted state when the wait begins.
    #[arg(long)]
    now: bool,
    /// Give up after this long: 30s, 10m, 2h (exit 1).
    #[arg(long = "for")]
    limit: Option<String>,
}

/// One pane as a listing shows it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Seen {
    pub label: String,
    pub state: String,
}

/// A pane that counted, and the state it counted in (`exited` when gone).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Counted {
    pub pane: String,
    pub label: String,
    pub state: String,
}

/// `30s`, `10m`, `2h`, or a bare number of seconds.
pub(crate) fn duration(text: &str) -> Option<Duration> {
    let (number, unit) = match text.char_indices().find(|(_, c)| !c.is_ascii_digit()) {
        Some((at, _)) => text.split_at(at),
        None => (text, "s"),
    };
    let n: u64 = number.parse().ok()?;
    let seconds = match unit {
        "s" => n,
        "m" => n.checked_mul(60)?,
        "h" => n.checked_mul(3600)?,
        _ => return None,
    };
    Some(Duration::from_secs(seconds))
}

pub(crate) fn parse_listing(listing: &str) -> HashMap<String, Seen> {
    listing
        .lines()
        .filter_map(|line| {
            let mut fields = line.splitn(3, '\t');
            let pane = fields.next()?.trim();
            pane.starts_with('%').then(|| {
                let label = fields.next().unwrap_or_default().to_string();
                let state = fields.next().unwrap_or_default().trim().to_string();
                (pane.to_string(), Seen { label, state })
            })
        })
        .collect()
}

/// The pane each target names: an id as it is, a label when exactly one
/// pane carries it. The first target that names none or several is said.
pub(crate) fn resolve(
    targets: &[String],
    panes: &HashMap<String, Seen>,
) -> Result<Vec<String>, String> {
    targets
        .iter()
        .map(|target| {
            if target.starts_with('%') {
                return if panes.contains_key(target) {
                    Ok(target.clone())
                } else {
                    Err(format!("no pane {target}"))
                };
            }
            let named: Vec<&String> = panes
                .iter()
                .filter(|(_, seen)| seen.label == *target)
                .map(|(pane, _)| pane)
                .collect();
            match named.as_slice() {
                [one] => Ok((*one).clone()),
                [] => Err(format!("no pane is labelled {target:?}")),
                _ => Err(format!("{} panes are labelled {target:?}", named.len())),
            }
        })
        .collect()
}

/// One wait, fed listings in turn: the first is the state at the start.
pub(crate) struct Waiter {
    panes: Vec<String>,
    wanted: Vec<&'static str>,
    all: bool,
    /// What each pane was when it was last read; a pane counts when it
    /// reaches a wanted state from something else.
    before: HashMap<String, String>,
    counted: Vec<Counted>,
    /// A pane went away that the wait was not for: it cannot end as asked.
    pub(crate) gone: bool,
}

impl Waiter {
    pub(crate) fn new(panes: Vec<String>, until: &[Until], all: bool, now: bool) -> Self {
        let until = if until.is_empty() {
            &SETTLED[..]
        } else {
            until
        };
        let before = if now {
            HashMap::new()
        } else {
            // Unread before the first listing: anything but a wanted state.
            panes.iter().map(|p| (p.clone(), "?".to_string())).collect()
        };
        Waiter {
            panes,
            wanted: until.iter().map(|u| u.pane_state()).collect(),
            all,
            before,
            counted: Vec::new(),
            gone: false,
        }
    }

    /// Take in a listing; the panes that counted once the wait is over.
    pub(crate) fn read(
        &mut self,
        panes: &HashMap<String, Seen>,
        first: bool,
    ) -> Option<Vec<Counted>> {
        for pane in &self.panes {
            if self.counted.iter().any(|c| &c.pane == pane) {
                continue;
            }
            let Some(seen) = panes.get(pane) else {
                self.counted.push(Counted {
                    pane: pane.clone(),
                    label: String::new(),
                    state: EXITED.into(),
                });
                if !self.wanted.contains(&EXITED) {
                    self.gone = true;
                }
                continue;
            };
            let wanted = self.wanted.contains(&seen.state.as_str());
            let was = self.before.get(pane).map(String::as_str);
            let arrived =
                wanted && was != Some(seen.state.as_str()) && !(first && was == Some("?"));
            if arrived {
                self.counted.push(Counted {
                    pane: pane.clone(),
                    label: seen.label.clone(),
                    state: seen.state.clone(),
                });
            }
            self.before.insert(pane.clone(), seen.state.clone());
        }
        let done = if self.gone {
            true
        } else if self.all {
            self.counted.len() == self.panes.len()
        } else {
            !self.counted.is_empty()
        };
        done.then(|| self.counted.clone())
    }
}

fn listing() -> Result<HashMap<String, Seen>, (i32, String)> {
    let argv = [
        "list-panes".into(),
        "-a".into(),
        "-F".into(),
        listing_format(),
    ];
    match tmuxy_core::session::tmux_output(&argv) {
        Ok(out) => Ok(parse_listing(&out)),
        Err(e) if tmuxy_core::session::is_no_server(&e.to_string()) => Err((
            EXIT_NO_SERVER,
            format!(
                "no tmux server on socket '{}'",
                tmuxy_core::session::tmux_socket()
            ),
        )),
        Err(e) => Err((EXIT_FAILED, e.to_string())),
    }
}

pub fn run(answer: &Answer, args: WaitArgs) {
    let limit = match args.limit.as_deref().map(duration) {
        Some(None) => answer.exit(EXIT_USAGE, "--for takes a duration: 30s, 10m, 2h"),
        Some(Some(limit)) => Some(limit),
        None => None,
    };
    let fail = |(code, message): (i32, String)| -> ! { answer.exit(code, &message) };
    let first = listing().unwrap_or_else(|e| fail(e));
    let panes = resolve(&args.targets, &first).unwrap_or_else(|e| fail((EXIT_TARGET, e)));
    let mut waiter = Waiter::new(panes, &args.until, args.all, args.now);
    let started = Instant::now();
    let deadline = limit.map(|limit| started + limit);
    let mut snapshot = first;
    let mut is_first = true;
    let counted = loop {
        if let Some(counted) = waiter.read(&snapshot, is_first) {
            break counted;
        }
        is_first = false;
        if deadline.is_some_and(|at| Instant::now() >= at) {
            answer.exit(EXIT_FAILED, "the wait timed out");
        }
        std::thread::sleep(if started.elapsed() < FAST_FOR {
            POLL
        } else {
            SLOW_POLL
        });
        snapshot = listing().unwrap_or_else(|e| fail(e));
    };
    let text = counted
        .iter()
        .map(|c| {
            let label = if c.label.is_empty() {
                String::new()
            } else {
                format!(" {}", c.label)
            };
            format!("{}{label} {}", c.pane, c.state)
        })
        .collect::<Vec<_>>()
        .join("\n");
    let panes = counted
        .iter()
        .map(|c| {
            serde_json::json!({ "paneId": c.pane, "label": c.label, "state": c.state }).to_string()
        })
        .collect::<Vec<_>>()
        .join(",");
    if waiter.gone {
        let gone: Vec<&str> = counted
            .iter()
            .filter(|c| c.state == EXITED)
            .map(|c| c.pane.as_str())
            .collect();
        answer.exit(
            EXIT_TARGET,
            &format!("{} went away before it got there", gone.join(", ")),
        );
    }
    answer.done(&[("panes", format!("[{panes}]"))], &text);
}

#[cfg(test)]
#[path = "wait_tests.rs"]
mod tests;
