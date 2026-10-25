use std::collections::BTreeMap;
use std::future::Future;
use std::path::Path;

use crate::error::TmuxError;

use super::*;

// =============================================================================
// Restore
// =============================================================================

/// The helper that parks a restored group member (`bin/tmuxy/pane-group-park`).
pub(super) fn park_script() -> String {
    crate::session::bin_dir()
        .join("tmuxy")
        .join("pane-group-park")
        .to_string_lossy()
        .into_owned()
}

/// The server option a restore's shell step leaves its answer in.
const RESTORE_ANSWER: &str = "@tmuxy-restore-answer";

/// Run `shell` through `run-shell` and keep what it printed as `key`.
///
/// Not by reading run-shell's own output: tmux 3.4 does not hand that back to
/// a control client, it opens it in view-mode on the current pane — and a
/// pane in view-mode takes the keys the restore types next as mode commands,
/// one of which opens a prompt that leaves the control client answering
/// nothing more. So the shell writes its output into a server option, which
/// is read back and cleared, and the shell step always succeeds (a "returned
/// 1" is view-mode output too); a failure surfaces as an answer the next
/// steps cannot use as a target. A `run-shell` a client sends is relayed the
/// same way (`control_mode/monitor/run_shell.rs`).
fn ask_run_shell(key: &str, shell: &str) -> Vec<Step> {
    let relay = format!(
        "{} set-option -g {RESTORE_ANSWER} \"$({shell} 2>&1)\"; true",
        tmux_shell_command()
    );
    vec![
        Step::Run(argv(&["run-shell", &relay])),
        Step::Ask {
            key: key.to_string(),
            argv: argv(&["show-options", "-gv", RESTORE_ANSWER]),
        },
        Step::Run(argv(&["set-option", "-gu", RESTORE_ANSWER])),
    ]
}

#[derive(Debug, Clone, Default)]
pub struct RestoreOptions {
    /// Run each offered command instead of leaving it typed at the prompt.
    pub run: bool,
    /// A directory to use when a pane's own has gone.
    pub fallback_cwd: String,
    /// The session already exists with one window at index 0 (the one
    /// `new-session -A` just made) — build onto it instead of creating one.
    /// This is the restore-on-start path, which runs over control mode after
    /// the client has attached, so there is never a clientless server.
    pub onto_existing_window: bool,
    /// The index that window has. `base-index` decides it (tmuxy's config
    /// says 1), so it is asked of tmux rather than assumed; `None` means 0.
    pub existing_window_index: Option<u32>,
}

impl Snapshot {
    /// What the first window should be made as, for a `new-session -A` that
    /// will be built onto: its name and its first pane's directory.
    pub fn first_window_hint(&self, fallback_cwd: &str) -> Option<(String, String)> {
        let first = self.windows.first()?;
        let cwd = first
            .panes
            .first()
            .map(|p| p.cwd.as_str())
            .filter(|c| !c.is_empty() && Path::new(c).is_dir())
            .unwrap_or(fallback_cwd);
        Some((first.name.clone(), cwd.to_string()))
    }
}

/// A tmux command as argv, without the `tmux` word.
pub type TmuxArgv = Vec<String>;

/// Something a restore needs tmux to run or answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Step {
    /// Run this; the output does not matter.
    Run(TmuxArgv),
    /// Run this and keep the trimmed output under `key`, for later steps to
    /// name as `#<key>#`.
    Ask { key: String, argv: TmuxArgv },
}

/// Fill `#<key>#` placeholders from the answers so far.
pub fn fill(argv: &[String], answers: &BTreeMap<String, String>) -> TmuxArgv {
    argv.iter()
        .map(|a| {
            let mut out = a.clone();
            for (key, value) in answers {
                out = out.replace(&format!("#{key}#"), value);
            }
            out
        })
        .collect()
}

/// Run every step of `steps` through `run`, threading answers into the steps
/// after them.
///
/// `run` is the only thing that touches tmux — a monitor's reply channel
/// (`via_monitor`), a subprocess from the CLI, or a fake in a test — which is
/// what lets a plan be tested by reading it back and the executor be tested
/// without tmux. It takes one tmux command as argv (without `tmux`) and
/// returns what the command printed.
pub async fn run_steps<F, Fut>(steps: &[Step], mut run: F) -> Result<(), TmuxError>
where
    F: FnMut(Vec<String>) -> Fut,
    Fut: Future<Output = Result<String, TmuxError>>,
{
    let mut answers = BTreeMap::new();
    for step in steps {
        match step {
            Step::Run(argv) => {
                run(fill(argv, &answers)).await?;
            }
            Step::Ask { key, argv } => {
                let answer = run(fill(argv, &answers)).await?.trim().to_string();
                answers.insert(key.clone(), answer);
            }
        }
    }
    Ok(())
}

/// Plan and run a restore through `run` (see `run_steps`).
pub async fn apply<F, Fut>(
    snapshot: &Snapshot,
    options: &RestoreOptions,
    run: F,
) -> Result<(), TmuxError>
where
    F: FnMut(Vec<String>) -> Fut,
    Fut: Future<Output = Result<String, TmuxError>>,
{
    run_steps(&plan(snapshot, options), run).await
}

fn target(session: &str, window_index: u32) -> String {
    format!("{session}:{window_index}")
}

pub(super) fn pane_target(session: &str, window_index: u32, pane_index: u32) -> String {
    format!("{session}:{window_index}.{pane_index}")
}

fn cwd_or_fallback(cwd: &str, options: &RestoreOptions) -> String {
    if !cwd.is_empty() && Path::new(cwd).is_dir() {
        cwd.to_string()
    } else {
        options.fallback_cwd.clone()
    }
}

fn argv(words: &[&str]) -> TmuxArgv {
    words.iter().map(|w| (*w).to_string()).collect()
}

/// A restored pane's command, brought back. Run at once when asked to (or
/// for tmuxy's own sidebar widget); otherwise OFFERED: hung on the pane as an
/// `@tmuxy-ask` question of kind `offer`, which the client draws as a
/// one-line banner and answers by running or dropping it. Typing it instead
/// raced the shell's start-up and showed it twice, and left nothing that said
/// the pane still owed an answer.
fn offer_steps(pane: &str, command: &str, run: bool, token: &str) -> Vec<Step> {
    if run {
        return vec![
            Step::Run(argv(&["send-keys", "-t", pane, "-l", command])),
            Step::Run(argv(&["send-keys", "-t", pane, "Enter"])),
        ];
    }
    vec![Step::Run(argv(&[
        "set-option",
        "-p",
        "-t",
        pane,
        tmux_options::ASK,
        &offer_payload(token, command),
    ]))]
}

/// The `@tmuxy-ask` value of an offer: base64 of `{token, kind, command}`,
/// the shape `tmuxy pane send` writes for its own questions.
pub fn offer_payload(token: &str, command: &str) -> String {
    use base64::Engine;
    let json = serde_json::json!({ "token": token, "kind": "offer", "command": command });
    base64::engine::general_purpose::STANDARD.encode(json.to_string())
}

/// The command an `@tmuxy-ask` value offers, when it is an offer at all.
pub fn offered_by(ask: &str) -> Option<String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD.decode(ask).ok()?;
    let value: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    if value.get("kind")?.as_str()? != "offer" {
        return None;
    }
    let command = value.get("command")?.as_str()?;
    (!command.is_empty()).then(|| command.to_string())
}

/// The tmux commands that rebuild a session from its snapshot, in order.
///
/// Why the shape is what it is:
///
///   * Windows are made with `split-window ; break-pane`, never `new-window`:
///     `new-window` crashes tmux 3.5a while a control-mode client is attached
///     (docs/TMUX.md), and a restore run from the CLI is exactly that case.
///   * Panes are split in index order and the layout applied LAST: tmux maps a
///     layout's cells onto panes by their order, so a window with the right
///     number of panes takes its old layout exactly.
///   * `@tmuxy-float-parent` is a window ID, which does not survive. It is
///     looked up (`Ask`) by the parent's index after every window exists.
///   * Each offered command is offered (`offer_steps`), not typed or run;
///     `run` types it and adds the Enter. A program that was running is not
///     proof it should run again.
///   * A pane with saved scrollback starts as `cat` of that text and then the
///     shell, so what was on screen is on screen again above a fresh prompt.
pub fn plan(snapshot: &Snapshot, options: &RestoreOptions) -> Vec<Step> {
    let mut steps = Vec::new();
    if snapshot.windows.is_empty() {
        return steps;
    }
    session_steps(snapshot, options, &mut steps);
    window_steps(snapshot, options, &mut steps);
    pane_steps(snapshot, options, &mut steps);
    hidden_member_steps(snapshot, options, &mut steps);
    float_parent_steps(snapshot, &mut steps);
    content_steps(snapshot, options, &mut steps);
    focus_steps(snapshot, &mut steps);
    steps
}

/// The first window's first pane's directory, or the fallback.
fn first_cwd(w: &WindowSnapshot, options: &RestoreOptions) -> String {
    w.panes
        .first()
        .map(|p| cwd_or_fallback(&p.cwd, options))
        .unwrap_or_else(|| options.fallback_cwd.clone())
}

/// The session, with its first window — or the window `new-session -A`
/// already made, renamed and moved to the first window's index.
fn session_steps(snapshot: &Snapshot, options: &RestoreOptions, steps: &mut Vec<Step>) {
    let s = &snapshot.session;
    let Some(first) = snapshot.windows.first() else {
        return;
    };
    let first_pane_cwd = first_cwd(first, options);
    if options.onto_existing_window {
        let placeholder = options.existing_window_index.unwrap_or(0);
        steps.push(Step::Run(argv(&[
            "rename-window",
            "-t",
            &target(s, placeholder),
            &first.name,
        ])));
        if first.index != placeholder {
            steps.push(Step::Run(argv(&[
                "move-window",
                "-s",
                &target(s, placeholder),
                "-t",
                &target(s, first.index),
            ])));
        }
    } else {
        steps.push(Step::Run(argv(&[
            "new-session",
            "-d",
            "-s",
            s,
            "-n",
            &first.name,
            "-c",
            &first_pane_cwd,
        ])));
    }
}

/// Every other window: split off the first window, break out at its index.
/// `-P -F` prints the new pane's id, and that id is what gets broken out —
/// never "the current pane", which is whatever the user is looking at.
fn window_steps(snapshot: &Snapshot, options: &RestoreOptions, steps: &mut Vec<Step>) {
    let s = &snapshot.session;
    let Some(first) = snapshot.windows.first() else {
        return;
    };
    for w in snapshot.windows.iter().skip(1) {
        let cwd = first_cwd(w, options);
        let key = format!("PANE_W{}", w.index);
        steps.push(Step::Ask {
            key: key.clone(),
            argv: argv(&[
                "split-window",
                "-d",
                "-t",
                &target(s, first.index),
                "-c",
                &cwd,
                "-P",
                "-F",
                "#{pane_id}",
            ]),
        });
        steps.push(Step::Run(argv(&[
            "break-pane",
            "-d",
            "-s",
            &format!("#{key}#"),
            "-t",
            &target(s, w.index),
            "-n",
            &w.name,
        ])));
    }
}

/// Each window's panes and layout, and its options.
fn pane_steps(snapshot: &Snapshot, options: &RestoreOptions, steps: &mut Vec<Step>) {
    let s = &snapshot.session;
    for w in &snapshot.windows {
        for p in w.panes.iter().skip(1) {
            steps.push(Step::Run(argv(&[
                "split-window",
                "-d",
                "-t",
                &target(s, w.index),
                "-c",
                &cwd_or_fallback(&p.cwd, options),
            ])));
        }
        if !w.layout.is_empty() && w.panes.len() > 1 {
            steps.push(Step::Run(argv(&[
                "select-layout",
                "-t",
                &target(s, w.index),
                &restorable_layout(&w.layout),
            ])));
        }
        if let Some(kind) = &w.window_type {
            steps.push(Step::Run(argv(&[
                "set-option",
                "-w",
                "-t",
                &target(s, w.index),
                tmux_options::WINDOW_TYPE,
                kind,
            ])));
        }
        for (name, value) in &w.options {
            steps.push(Step::Run(argv(&[
                "set-option",
                "-w",
                "-t",
                &target(s, w.index),
                name,
                value,
            ])));
        }
        for p in &w.panes {
            for (name, value) in &p.options {
                steps.push(Step::Run(argv(&[
                    "set-option",
                    "-p",
                    "-t",
                    &pane_target(s, w.index, p.index),
                    name,
                    value,
                ])));
            }
        }
    }
}

/// Hidden group members, now that every visible member carries its tag:
/// each is split off its group's visible member and parked in the stash
/// (`pane-group-park`, the half of `pane group add` that hides a pane),
/// which prints the new pane's id for what follows. The split and the break
/// leave the anchor's window as it was, but a layout is re-applied to be
/// sure, since the select-layout of `pane_steps` ran before the split.
fn hidden_member_steps(snapshot: &Snapshot, options: &RestoreOptions, steps: &mut Vec<Step>) {
    let s = &snapshot.session;
    let mut parked_windows = std::collections::BTreeSet::new();
    for (n, member) in snapshot.hidden.iter().enumerate() {
        let anchor = snapshot.windows.iter().find_map(|w| {
            w.panes
                .iter()
                .find(|p| {
                    p.options
                        .get(tmux_options::GROUP_ID)
                        .is_some_and(|g| member.group_id == g.as_str())
                })
                .map(|p| (w, p))
        });
        let Some((w, p)) = anchor else { continue };
        let key = format!("HID{n}");
        let park = format!(
            "bash {} {} {} {}{}",
            shell_quote(&park_script()),
            shell_quote(&pane_target(s, w.index, p.index)),
            shell_quote(member.group_id.as_str()),
            shell_quote(&cwd_or_fallback(&member.cwd, options)),
            member
                .position
                .map(|pos| format!(" {pos}"))
                .unwrap_or_default(),
        );
        steps.extend(ask_run_shell(&key, &park));
        let pane = format!("#{key}#");
        if let Some(word) = &member.restore_command {
            steps.push(Step::Run(argv(&[
                "set-option",
                "-p",
                "-t",
                &pane,
                RESTORE_OPTION,
                word,
            ])));
        }
        if let Some(cmd) = member.offered_command() {
            steps.extend(offer_steps(
                &pane,
                &cmd,
                options.run,
                &format!("restore-{key}"),
            ));
        }
        parked_windows.insert(w.index);
    }
    for w in &snapshot.windows {
        if parked_windows.contains(&w.index) && !w.layout.is_empty() && w.panes.len() > 1 {
            steps.push(Step::Run(argv(&[
                "select-layout",
                "-t",
                &target(s, w.index),
                &restorable_layout(&w.layout),
            ])));
        }
    }
}

/// Float parents, now that every window has an id.
fn float_parent_steps(snapshot: &Snapshot, steps: &mut Vec<Step>) {
    let s = &snapshot.session;
    for w in &snapshot.windows {
        if let Some(parent) = w.float_parent_index {
            let key = format!("WIN{parent}");
            steps.push(Step::Ask {
                key: key.clone(),
                argv: argv(&[
                    "display-message",
                    "-p",
                    "-t",
                    &target(s, parent),
                    "#{window_id}",
                ]),
            });
            steps.push(Step::Run(argv(&[
                "set-option",
                "-w",
                "-t",
                &target(s, w.index),
                tmux_options::FLOAT_PARENT,
                &format!("#{key}#"),
            ])));
        }
    }
}

/// What each pane was doing: its scrollback printed back, its program offered.
fn content_steps(snapshot: &Snapshot, options: &RestoreOptions, steps: &mut Vec<Step>) {
    let s = &snapshot.session;
    for w in &snapshot.windows {
        for p in &w.panes {
            let pane = pane_target(s, w.index, p.index);
            if let Some(lines) = &p.scrollback {
                if !lines.is_empty() {
                    // Printed, not typed: `-l` would send it to the shell.
                    let text = lines.join("\n");
                    steps.push(Step::Run(argv(&[
                        "run-shell",
                        "-t",
                        &pane,
                        &format!("printf '%s\\n' {}", shell_quote(&text)),
                    ])));
                }
            }
            if let Some(cmd) = p.offered_command() {
                let chrome = w.is_chrome();
                if let (Some(word), false) = (&p.restore_command, chrome) {
                    // The program's own word outlives the offer: typed and
                    // not run, it would otherwise be gone from the next save.
                    steps.push(Step::Run(argv(&[
                        "set-option",
                        "-p",
                        "-t",
                        &pane,
                        RESTORE_OPTION,
                        word,
                    ])));
                }
                let token = format!("restore-{}-{}", w.index, p.index);
                steps.extend(offer_steps(&pane, &cmd, options.run || chrome, &token));
            }
        }
    }
}

/// Focus, last: the active pane of every window, then the active window.
fn focus_steps(snapshot: &Snapshot, steps: &mut Vec<Step>) {
    let s = &snapshot.session;
    for w in &snapshot.windows {
        if let Some(p) = w.panes.iter().find(|p| p.active) {
            steps.push(Step::Run(argv(&[
                "select-pane",
                "-t",
                &pane_target(s, w.index, p.index),
            ])));
        }
    }
    if let Some(w) = snapshot.windows.iter().find(|w| w.active) {
        steps.push(Step::Run(argv(&[
            "select-window",
            "-t",
            &target(s, w.index),
        ])));
    }
}
