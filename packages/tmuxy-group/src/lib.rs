//! The pane-group operations, run: `tmuxy-group <verb>`, and the same verbs
//! as `tmuxy-server group <verb>`.
//!
//! The rules live in `tmuxy_core::groups`; this reads the panes once, asks it
//! for the commands and runs them. The `bin/tmuxy/pane-group-*` scripts are
//! its names: the UI, the key bindings and session restore call them inside
//! `tmux run-shell`, where these tmux calls are tmux-internal (see
//! `tmuxy_core::session::tmux_output`). A refusal prints
//! `pane-group-<verb>: <why>` and exits 1.

use tmuxy_core::groups::{self, Context, Direction, Invocation, Leave, Panes, Side};
use tmuxy_core::session::tmux_output as tmux;
use tmuxy_core::{GroupId, PaneId};

#[derive(clap::Args, Debug)]
pub struct GroupArgs {
    #[command(subcommand)]
    pub verb: GroupVerb,
}

#[derive(clap::Subcommand, Debug)]
pub enum GroupVerb {
    /// A new pane in PANE's group (a new group when it has none), shown in
    /// PANE's place.
    Add {
        pane: String,
        width: String,
        height: String,
    },
    /// A new pane in GROUP, parked out of view beside ANCHOR (any tmux
    /// target) in CWD, at POS in the order. Prints the new pane's id.
    Park {
        anchor: String,
        group: String,
        cwd: String,
        pos: Option<String>,
    },
    /// Close PANE; a member on screen hands its place to the next first.
    Close { pane: String },
    /// Show PANE in its group's slot.
    Switch { pane: String },
    /// Show the member after the one on screen (wrapping). With `--no-wrap`,
    /// exit 3 instead of wrapping or when PANE is in no group.
    Next {
        pane: String,
        #[arg(long)]
        no_wrap: bool,
    },
    /// Show the member before the one on screen (wrapping). With `--no-wrap`,
    /// exit 3 instead of wrapping or when PANE is in no group.
    Prev {
        pane: String,
        #[arg(long)]
        no_wrap: bool,
    },
    /// Put PANE at INDEX in its group's order (0 is first).
    Move {
        pane: String,
        #[arg(allow_hyphen_values = true)]
        index: String,
    },
    /// Make PANE a member of ANCHOR's group, out of view, at INDEX.
    Join {
        pane: String,
        anchor: String,
        #[arg(allow_hyphen_values = true)]
        index: Option<String>,
    },
    /// Take PANE out of its group: `--tab` (the default) or
    /// `--beside <pane> <left|right|up|down>`.
    Leave {
        pane: String,
        #[arg(allow_hyphen_values = true, num_args = 0..)]
        to: Vec<String>,
    },
}

/// The exit status of `next`/`prev --no-wrap` with no member to step to.
const NOTHING_TO_STEP_TO: i32 = 3;

impl GroupVerb {
    fn name(&self) -> &'static str {
        match self {
            Self::Add { .. } => "add",
            Self::Park { .. } => "park",
            Self::Close { .. } => "close",
            Self::Switch { .. } => "switch",
            Self::Next { .. } => "next",
            Self::Prev { .. } => "prev",
            Self::Move { .. } => "move",
            Self::Join { .. } => "join",
            Self::Leave { .. } => "leave",
        }
    }
}

pub fn run(args: GroupArgs) {
    let name = args.verb.name();
    match execute(args.verb) {
        Ok(Some(printed)) => println!("{printed}"),
        Ok(None) => {}
        Err(Outcome::Exit(code)) => std::process::exit(code),
        Err(Outcome::Fail(message)) => {
            eprintln!("pane-group-{name}: {message}");
            std::process::exit(1);
        }
    }
}

/// How a verb ends other than in success.
enum Outcome {
    Fail(String),
    Exit(i32),
}

impl From<String> for Outcome {
    fn from(message: String) -> Self {
        Self::Fail(message)
    }
}

impl From<groups::GroupError> for Outcome {
    fn from(e: groups::GroupError) -> Self {
        Self::Fail(e.to_string())
    }
}

impl From<tmuxy_core::IdError> for Outcome {
    fn from(e: tmuxy_core::IdError) -> Self {
        Self::Fail(e.to_string())
    }
}

fn execute(verb: GroupVerb) -> Result<Option<String>, Outcome> {
    let ctx = context();
    match verb {
        GroupVerb::Add {
            pane,
            width,
            height,
        } => {
            let anchor = PaneId::parse(&pane)?;
            let size = (number(&width, "width")?, number(&height, "height")?);
            let plan = groups::add(&read()?, &anchor, &ctx)?;
            let new = split(&plan)?;
            run_all(&groups::add_finish(&anchor, &plan.group, &new, size, &ctx))?;
            Ok(None)
        }
        GroupVerb::Park {
            anchor,
            group,
            cwd,
            pos,
        } => {
            let anchor = resolve_pane(&anchor)?;
            let group = GroupId::parse(&group)?;
            let pos = match pos.as_deref() {
                None | Some("") => None,
                Some(pos) => Some(number(pos, "position")?),
            };
            let panes = read()?;
            let plan = groups::park_split(&panes, &anchor, &group, &cwd, &ctx)?;
            let new = split(&plan)?;
            run_all(&groups::park_finish(
                &panes, &anchor, &group, &new, pos, &ctx,
            ))?;
            Ok(Some(new.to_string()))
        }
        GroupVerb::Close { pane } => {
            run_all(&groups::close(&read()?, &PaneId::parse(&pane)?)?)?;
            Ok(None)
        }
        GroupVerb::Switch { pane } => {
            run_all(&groups::switch(&read()?, &PaneId::parse(&pane)?))?;
            Ok(None)
        }
        GroupVerb::Next { pane, no_wrap } => step(&pane, Direction::Next, no_wrap),
        GroupVerb::Prev { pane, no_wrap } => step(&pane, Direction::Prev, no_wrap),
        GroupVerb::Move { pane, index } => {
            let pane = PaneId::parse(&pane)?;
            let index = signed(&index)?;
            run_all(&groups::move_to(&read()?, &pane, index, &ctx)?)?;
            Ok(None)
        }
        GroupVerb::Join {
            pane,
            anchor,
            index,
        } => {
            let pane = PaneId::parse(&pane)?;
            let anchor = PaneId::parse(&anchor)?;
            let index = match index.as_deref() {
                None | Some("") => None,
                Some(index) => Some(signed(index)?),
            };
            run_all(&groups::join(&read()?, &pane, &anchor, index, &ctx)?)?;
            Ok(None)
        }
        GroupVerb::Leave { pane, to } => {
            let pane = PaneId::parse(&pane)?;
            let to = leave_target(&to)?;
            run_all(&groups::leave(&read()?, &pane, &to, &ctx)?)?;
            Ok(None)
        }
    }
}

fn step(pane: &str, direction: Direction, no_wrap: bool) -> Result<Option<String>, Outcome> {
    let pane = PaneId::parse(pane)?;
    let panes = read()?;
    let plan = if no_wrap {
        groups::step_within(&panes, &pane, direction)
    } else {
        groups::step(&panes, &pane, direction)
    };
    if plan.is_empty() && no_wrap {
        return Err(Outcome::Exit(NOTHING_TO_STEP_TO));
    }
    run_all(&plan)?;
    Ok(None)
}

/// `--tab` (or nothing, or anything else) / `--beside <pane> <side>`, as the
/// script has always read them; an empty side is `right`.
fn leave_target(to: &[String]) -> Result<Leave, Outcome> {
    let word = |i: usize| to.get(i).map(String::as_str).unwrap_or("");
    if word(0) != "--beside" {
        return Ok(Leave::Tab);
    }
    Ok(Leave::Beside {
        target: PaneId::parse(word(1))?,
        side: Side::parse(word(2))?,
    })
}

fn number(value: &str, what: &str) -> Result<u32, Outcome> {
    value
        .parse()
        .map_err(|_| Outcome::Fail(format!("{what} must be a number: {value:?}")))
}

fn signed(value: &str) -> Result<i64, Outcome> {
    value
        .parse()
        .map_err(|_| Outcome::Fail(format!("index must be a number: {value:?}")))
}

/// What the operations need beyond the read: the close script a member's
/// `pane-died` hook runs — the one next to the script that called us — and a
/// fresh `@tmuxy-group-rev`.
fn context() -> Context {
    let scripts = std::env::var("TMUXY_SCRIPTS_DIR")
        .ok()
        .filter(|d| !d.is_empty())
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| tmuxy_core::session::bin_dir().join("tmuxy"));
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    Context {
        close_script: scripts
            .join("pane-group-close")
            .to_string_lossy()
            .into_owned(),
        rev_token: format!(
            "{}.{}.{}",
            now.as_secs(),
            std::process::id(),
            now.subsec_nanos()
        ),
    }
}

/// The one read every operation decides from.
fn read() -> Result<Panes, Outcome> {
    let output = tmux(&[
        "list-panes".to_string(),
        "-a".to_string(),
        "-F".to_string(),
        groups::LIST_PANES_FORMAT.to_string(),
    ])?;
    Ok(Panes::parse(&output))
}

/// The pane a tmux target (`work:0.0`, `%3`, …) names.
fn resolve_pane(target: &str) -> Result<PaneId, Outcome> {
    let output = tmux(&[
        "display-message".to_string(),
        "-p".to_string(),
        "-t".to_string(),
        target.to_string(),
        "#{pane_id}".to_string(),
    ])?;
    Ok(PaneId::parse(output.trim())?)
}

/// Run a plan's first half and its split; the new pane's id.
fn split(plan: &groups::SplitPlan) -> Result<PaneId, Outcome> {
    run_all(&plan.before)?;
    let output = tmux(&plan.split)?;
    Ok(PaneId::parse(output.trim())?)
}

fn run_all(plan: &[Invocation]) -> Result<(), Outcome> {
    for invocation in plan {
        match tmux(&invocation.argv()) {
            Err(e) if !invocation.tolerant => return Err(Outcome::Fail(e)),
            _ => {}
        }
    }
    Ok(())
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    fn to(words: &[&str]) -> Vec<String> {
        words.iter().map(|w| w.to_string()).collect()
    }

    #[test]
    fn leave_reads_its_target_the_way_the_script_always_has() {
        assert_eq!(leave_target(&[]).ok(), Some(Leave::Tab));
        assert_eq!(leave_target(&to(&["--tab", "", ""])).ok(), Some(Leave::Tab));
        assert_eq!(
            leave_target(&to(&["--beside", "%2", "up"])).ok(),
            Some(Leave::Beside {
                target: PaneId::parse("%2").unwrap(),
                side: Side::Up,
            })
        );
        assert_eq!(
            leave_target(&to(&["--beside", "%2"])).ok(),
            Some(Leave::Beside {
                target: PaneId::parse("%2").unwrap(),
                side: Side::Right,
            })
        );
        assert!(matches!(
            leave_target(&to(&["--beside", "%2", "sideways"])),
            Err(Outcome::Fail(m)) if m == "direction must be left, right, up or down"
        ));
        assert!(matches!(
            leave_target(&to(&["--beside", ""])),
            Err(Outcome::Fail(m)) if m.starts_with("not a pane id")
        ));
    }

    #[test]
    fn numbers_are_checked_before_anything_runs() {
        assert!(number("80", "width").is_ok());
        assert!(matches!(
            number("wide", "width"),
            Err(Outcome::Fail(m)) if m == "width must be a number: \"wide\""
        ));
        assert_eq!(signed("-2").ok(), Some(-2));
    }

    #[test]
    fn every_verb_parses_with_the_scripts_arguments() {
        use clap::Parser;
        #[derive(clap::Parser)]
        struct Cli {
            #[command(subcommand)]
            verb: GroupVerb,
        }
        let parse = |argv: &[&str]| {
            Cli::try_parse_from(std::iter::once("group").chain(argv.iter().copied()))
                .map(|c| c.verb.name())
        };
        assert_eq!(parse(&["add", "%1", "80", "24"]).unwrap(), "add");
        assert_eq!(parse(&["park", "work:0.0", "g1", "/tmp"]).unwrap(), "park");
        assert_eq!(
            parse(&["park", "work:0.0", "g1", "/tmp", "2"]).unwrap(),
            "park"
        );
        assert_eq!(parse(&["move", "%4", "-1"]).unwrap(), "move");
        assert_eq!(parse(&["join", "%9", "%4", ""]).unwrap(), "join");
        assert_eq!(parse(&["leave", "%5", "--tab", "", ""]).unwrap(), "leave");
        assert_eq!(
            parse(&["leave", "%5", "--beside", "%2", "down"]).unwrap(),
            "leave"
        );
        assert_eq!(parse(&["next", "%1", "--no-wrap"]).unwrap(), "next");
        assert!(parse(&["switch"]).is_err());
    }
}
