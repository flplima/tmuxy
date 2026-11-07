//! The pane-group operations, the `group` verb. The
//! `packages/tmuxy-cli/bin/tmuxy/pane-group` script is their name: the UI,
//! the key bindings, session restore and `tmuxy pane group` call it inside
//! `tmux run-shell`, where these tmux calls are tmux-internal (see
//! `tmuxy_core::session::tmux_output`). It answers under the CLI's contract
//! (`cli_json`); a refusal's message starts `pane-group <verb>:`.

use tmuxy_core::groups::{self, Context, Direction, Invocation, Leave, Panes, Side};
use tmuxy_core::session::tmux_output as tmux;
use tmuxy_core::{GroupId, PaneId};

use crate::cli_json::{self, Answer, EXIT_FAILED, EXIT_TARGET};

#[derive(clap::Args, Debug)]
pub struct GroupArgs {
    /// Answer in JSON.
    #[arg(long, global = true)]
    json: bool,
    #[command(subcommand)]
    pub verb: GroupVerb,
}

/// A PANE left out is the caller's (`TMUX_PANE`), else the session's current
/// pane.
#[derive(clap::Subcommand, Debug)]
pub enum GroupVerb {
    /// A new pane in PANE's group (a new group when it has none), shown in
    /// PANE's place, WIDTH by HEIGHT (PANE's size when left out).
    Add {
        pane: Option<String>,
        width: Option<String>,
        height: Option<String>,
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
    Close { pane: Option<String> },
    /// Kill the stash windows of groups left with no member on screen (the
    /// parked members of a tab that was killed outright).
    Gc,
    /// Show PANE in its group's slot.
    Switch { pane: String },
    /// Show the member after the one on screen (wrapping). With `--no-wrap`,
    /// exit 3 instead of wrapping or when PANE is in no group.
    Next {
        pane: Option<String>,
        #[arg(long)]
        no_wrap: bool,
    },
    /// Show the member before the one on screen (wrapping). With `--no-wrap`,
    /// exit 3 instead of wrapping or when PANE is in no group.
    Prev {
        pane: Option<String>,
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
    /// Take PANE out of its group, as a tab of its own (the default) or split
    /// in beside another pane.
    Leave {
        pane: Option<String>,
        /// A tab of its own.
        #[arg(long, conflicts_with = "beside")]
        tab: bool,
        /// Split in beside PANE, on the DIR side (left, right, up or down;
        /// right when left out).
        #[arg(long, num_args = 1..=2, value_names = ["PANE", "DIR"])]
        beside: Option<Vec<String>>,
    },
    /// Every other pane of PANE's tab joins PANE's group, in tab order.
    All { pane: Option<String> },
    /// PANE's group comes apart: each other member back as a split beside
    /// PANE, in group order, PANE out of the group, and the tab tiled.
    Ungroup { pane: Option<String> },
}

impl GroupVerb {
    fn name(&self) -> &'static str {
        match self {
            Self::Add { .. } => "add",
            Self::Park { .. } => "park",
            Self::Close { .. } => "close",
            Self::Gc => "gc",
            Self::Switch { .. } => "switch",
            Self::Next { .. } => "next",
            Self::Prev { .. } => "prev",
            Self::Move { .. } => "move",
            Self::Join { .. } => "join",
            Self::Leave { .. } => "leave",
            Self::All { .. } => "all",
            Self::Ungroup { .. } => "ungroup",
        }
    }
}

pub fn run(args: GroupArgs) {
    let answer = Answer::new(args.json);
    let name = args.verb.name();
    match execute(args.verb) {
        Ok(Some(pane)) => answer.done(&[("paneId", cli_json::string(&pane))], &pane),
        Ok(None) => answer.done(&[], ""),
        // A status, not an error: `nav` reads it and moves on, and text
        // printed inside a key binding's `run-shell` lands on the pane.
        Err(Outcome::NothingThatWay) if !answer.is_json() => std::process::exit(EXIT_TARGET),
        Err(Outcome::NothingThatWay) => answer.exit(
            EXIT_TARGET,
            &format!("pane-group {name}: no member that way"),
        ),
        Err(Outcome::Fail(message)) => {
            answer.exit(EXIT_FAILED, &format!("pane-group {name}: {message}"))
        }
    }
}

enum Outcome {
    Fail(String),
    /// `--no-wrap` with no member that way.
    NothingThatWay,
}

impl From<tmuxy_core::TmuxError> for Outcome {
    fn from(e: tmuxy_core::TmuxError) -> Self {
        Self::Fail(e.to_string())
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
            let anchor = pane_or_caller(pane)?;
            let size = match (width, height) {
                (Some(width), Some(height)) => {
                    (number(&width, "width")?, number(&height, "height")?)
                }
                _ => size_of(&anchor)?,
            };
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
            run_all(&groups::close(&read()?, &pane_or_caller(pane)?)?)?;
            Ok(None)
        }
        GroupVerb::Gc => {
            run_all(&groups::gc(&read()?))?;
            Ok(None)
        }
        GroupVerb::Switch { pane } => {
            run_all(&groups::switch(&read()?, &PaneId::parse(&pane)?))?;
            Ok(None)
        }
        GroupVerb::Next { pane, no_wrap } => step(pane, Direction::Next, no_wrap),
        GroupVerb::Prev { pane, no_wrap } => step(pane, Direction::Prev, no_wrap),
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
        GroupVerb::Leave { pane, beside, .. } => {
            let pane = pane_or_caller(pane)?;
            let to = leave_target(beside.as_deref())?;
            run_all(&groups::leave(&read()?, &pane, &to, &ctx)?)?;
            Ok(None)
        }
        GroupVerb::All { pane } => {
            let anchor = pane_or_caller(pane)?;
            let panes = read()?;
            let Some(window) = panes.row(&anchor).map(|r| r.window.clone()) else {
                return Ok(None);
            };
            let others: Vec<PaneId> = panes
                .in_window(&window)
                .map(|r| r.pane.clone())
                .filter(|p| *p != anchor)
                .collect();
            // Each join parks the pane and tags it; the first makes the group.
            for other in others {
                run_all(&groups::join(&read()?, &other, &anchor, None, &ctx)?)?;
            }
            Ok(None)
        }
        GroupVerb::Ungroup { pane } => {
            let anchor = pane_or_caller(pane)?;
            let panes = read()?;
            let Some(group) = panes.group_of(&anchor).cloned() else {
                return Ok(None);
            };
            let members: Vec<PaneId> = panes
                .members(&group)
                .into_iter()
                .map(|r| r.pane.clone())
                .filter(|p| *p != anchor)
                .collect();
            let beside = Leave::Beside {
                target: anchor.clone(),
                side: Side::Right,
            };
            for member in members {
                run_all(&groups::leave(&read()?, &member, &beside, &ctx)?)?;
            }
            // A group left with one member dissolves on its own; only a pane
            // still tagged has a group to leave.
            let panes = read()?;
            if panes.group_of(&anchor).is_some() {
                run_all(&groups::leave(&panes, &anchor, &Leave::Tab, &ctx)?)?;
            }
            if let Some(row) = read()?.row(&anchor) {
                tmux(&[
                    "select-layout".to_string(),
                    "-t".to_string(),
                    row.window.to_string(),
                    "tiled".to_string(),
                ])?;
            }
            Ok(None)
        }
    }
}

fn step(
    pane: Option<String>,
    direction: Direction,
    no_wrap: bool,
) -> Result<Option<String>, Outcome> {
    let pane = pane_or_caller(pane)?;
    let panes = read()?;
    let plan = if no_wrap {
        groups::step_within(&panes, &pane, direction)
    } else {
        groups::step(&panes, &pane, direction)
    };
    if plan.is_empty() && no_wrap {
        return Err(Outcome::NothingThatWay);
    }
    run_all(&plan)?;
    Ok(None)
}

/// `--beside PANE [DIR]`, its side `right` when left out; a tab otherwise.
fn leave_target(beside: Option<&[String]>) -> Result<Leave, Outcome> {
    let Some(beside) = beside else {
        return Ok(Leave::Tab);
    };
    let word = |i: usize| beside.get(i).map(String::as_str).unwrap_or("");
    Ok(Leave::Beside {
        target: PaneId::parse(word(0))?,
        side: Side::parse(word(1))?,
    })
}

/// `pane`, else the caller's pane, else the session's current one.
fn pane_or_caller(pane: Option<String>) -> Result<PaneId, Outcome> {
    match pane.or_else(tmuxy_core::run_shell::caller_pane) {
        Some(pane) => Ok(PaneId::parse(&pane)?),
        None => resolve_pane(""),
    }
}

fn size_of(pane: &PaneId) -> Result<(u32, u32), Outcome> {
    let output = tmux(&[
        "display-message".to_string(),
        "-p".to_string(),
        "-t".to_string(),
        pane.to_string(),
        "#{pane_width} #{pane_height}".to_string(),
    ])?;
    let mut cells = output.split_whitespace();
    Ok((
        number(cells.next().unwrap_or_default(), "width")?,
        number(cells.next().unwrap_or_default(), "height")?,
    ))
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

/// `close_command` is what a member's `pane-died` hook runs: the
/// `pane-group` a restored member's hook names too.
fn context() -> Context {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let script = tmuxy_core::paths::Layout::current()
        .scripts()
        .join("pane-group");
    Context {
        close_command: groups::close_command(&script),
        rev_token: format!(
            "{}.{}.{}",
            now.as_secs(),
            std::process::id(),
            now.subsec_nanos()
        ),
    }
}

fn read() -> Result<Panes, Outcome> {
    let output = tmux(&[
        "list-panes".to_string(),
        "-a".to_string(),
        "-F".to_string(),
        groups::list_panes_format(),
    ])?;
    Ok(Panes::parse(&output))
}

/// The pane `target` names; the current one for `""`.
fn resolve_pane(target: &str) -> Result<PaneId, Outcome> {
    let mut argv = vec!["display-message".to_string(), "-p".to_string()];
    if !target.is_empty() {
        argv.extend(["-t".to_string(), target.to_string()]);
    }
    argv.push("#{pane_id}".to_string());
    let output = tmux(&argv)?;
    Ok(PaneId::parse(output.trim())?)
}

fn split(plan: &groups::SplitPlan) -> Result<PaneId, Outcome> {
    run_all(&plan.before)?;
    let output = tmux(&plan.split)?;
    Ok(PaneId::parse(output.trim())?)
}

fn run_all(plan: &[Invocation]) -> Result<(), Outcome> {
    for invocation in plan {
        match tmux(&invocation.argv()) {
            Err(e) if !invocation.tolerant => return Err(e.into()),
            _ => {}
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn to(words: &[&str]) -> Vec<String> {
        words.iter().map(|w| w.to_string()).collect()
    }

    #[test]
    fn leave_is_a_tab_unless_it_names_a_pane_to_go_beside() {
        assert_eq!(leave_target(None).ok(), Some(Leave::Tab));
        assert_eq!(
            leave_target(Some(&to(&["%2", "up"]))).ok(),
            Some(Leave::Beside {
                target: PaneId::parse("%2").unwrap(),
                side: Side::Up,
            })
        );
        assert_eq!(
            leave_target(Some(&to(&["%2"]))).ok(),
            Some(Leave::Beside {
                target: PaneId::parse("%2").unwrap(),
                side: Side::Right,
            })
        );
        assert!(matches!(
            leave_target(Some(&to(&["%2", "sideways"]))),
            Err(Outcome::Fail(m)) if m == "direction must be left, right, up or down"
        ));
        assert!(matches!(
            leave_target(Some(&to(&[""]))),
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
            #[command(flatten)]
            group: GroupArgs,
        }
        let parse = |argv: &[&str]| {
            Cli::try_parse_from(std::iter::once("group").chain(argv.iter().copied()))
                .map(|c| c.group.verb.name())
        };
        assert_eq!(parse(&["add", "%1", "80", "24"]).unwrap(), "add");
        assert_eq!(parse(&["park", "work:0.0", "g1", "/tmp"]).unwrap(), "park");
        assert_eq!(
            parse(&["park", "work:0.0", "g1", "/tmp", "2"]).unwrap(),
            "park"
        );
        assert_eq!(parse(&["move", "%4", "-1"]).unwrap(), "move");
        assert_eq!(parse(&["join", "%9", "%4", ""]).unwrap(), "join");
        assert_eq!(parse(&["leave", "%5", "--tab"]).unwrap(), "leave");
        assert_eq!(
            parse(&["leave", "%5", "--beside", "%2", "down"]).unwrap(),
            "leave"
        );
        assert_eq!(parse(&["leave", "--beside", "%2"]).unwrap(), "leave");
        assert!(parse(&["leave", "%5", "--tab", "--beside", "%2"]).is_err());
        assert_eq!(parse(&["add"]).unwrap(), "add");
        assert_eq!(parse(&["close", "--json"]).unwrap(), "close");
        assert_eq!(parse(&["next", "%1", "--no-wrap"]).unwrap(), "next");
        assert_eq!(parse(&["gc"]).unwrap(), "gc");
        assert!(parse(&["gc", "%1"]).is_err());
        assert!(parse(&["switch"]).is_err());
    }
}
