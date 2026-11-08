//! The install gate: what a plugin will be able to do, shown before any of
//! its code runs, and a yes asked of a person.
//!
//! The question goes to `/dev/tty`, never stdin, so `curl … | tmuxy plugin
//! install` cannot answer it. Without a terminal the gate prints the table on
//! stderr and fails closed unless the caller passes `--yes` with a `--sha
//! <commit>` for every commit fetched (the plugin's and each new
//! dependency's): a script names the exact commits it reviewed, never
//! "whatever is there now".

use std::io::{BufRead, IsTerminal, Write};

use tmuxy_core::plugins::keys;
use tmuxy_core::plugins::manifest::{
    Action, Dependency, Key, LinkHandler, LinkMatch, Manifest, Setting, Theme,
};
use tmuxy_core::plugins::registry::on_path;
use tmuxy_core::plugins::PluginError;

pub struct Subject<'a> {
    pub manifest: &'a Manifest,
    /// `owner/repo[/subdir]`, or the linked path.
    pub source: &'a str,
    /// The commit, `None` for a linked directory.
    pub sha: Option<&'a str>,
    /// What an update replaces.
    pub previous: Option<(&'a Manifest, Option<&'a str>)>,
}

struct Style {
    on: bool,
}

impl Style {
    fn paint(&self, code: &str, text: &str) -> String {
        if self.on {
            format!("\x1b[{code}m{text}\x1b[0m")
        } else {
            text.to_string()
        }
    }
    fn bold(&self, text: &str) -> String {
        self.paint("1", text)
    }
    fn red(&self, text: &str) -> String {
        self.paint("31", text)
    }
    fn yellow(&self, text: &str) -> String {
        self.paint("33", text)
    }
}

fn describe_action(a: &Action) -> String {
    let mut where_ = a.surface.as_str().to_string();
    if let Some(size) = a.size {
        where_.push_str(&format!(" {}", size.describe()));
    }
    if let Some(menu) = a.menu {
        where_.push_str(&format!(", {} menu", menu.as_str()));
    }
    format!("{} {:?} ({where_}): {}", a.id, a.title, a.command.join(" "))
}

/// The capability table, as text. `color` paints the warnings.
pub fn render(subject: &Subject<'_>, color: bool) -> String {
    let s = Style { on: color };
    let m = subject.manifest;
    let mut out = String::new();
    let mut line = |text: String| {
        out.push_str(&text);
        out.push('\n');
    };
    let heading = match subject.previous {
        Some(_) => "Update",
        None => "Install",
    };
    line(s.bold(&format!("{heading} plugin {} {}", m.name, m.version)));
    if !m.description.is_empty() {
        line(format!(
            "  {}",
            m.description.lines().next().unwrap_or_default()
        ));
    }
    line(format!("  from    {}", subject.source));
    match subject.sha {
        Some(sha) => line(format!("  commit  {sha}")),
        None => line("  commit  none: a linked directory, used as it is".to_string()),
    }
    if let Some((_, Some(old))) = subject.previous {
        line(format!("  was     {old}"));
    }
    line(String::new());
    line(
        s.yellow("  Plugin commands run unsandboxed as your user and can control every tmux pane."),
    );
    line(String::new());
    for (i, a) in m.actions.iter().enumerate() {
        let label = if i == 0 { "actions" } else { "" };
        line(format!("  {label:<10}{}", describe_action(a)));
    }
    for (i, c) in m.cli.iter().enumerate() {
        let label = if i == 0 { "cli verbs" } else { "" };
        line(format!(
            "  {label:<10}tmuxy plugin {}: {}",
            c.verb,
            c.command.join(" ")
        ));
    }
    if !m.requires.is_empty() {
        let list: Vec<String> = m
            .requires
            .iter()
            .map(|r| {
                if on_path(r) {
                    r.clone()
                } else {
                    s.red(&format!("{r} (not on PATH)"))
                }
            })
            .collect();
        line(format!("  {:<10}{}", "requires", list.join(", ")));
    }
    for (i, h) in m.link_handlers.iter().enumerate() {
        let label = if i == 0 { "links" } else { "" };
        line(format!("  {label:<10}{}", describe_link(h)));
    }
    for (i, k) in m.keys.iter().enumerate() {
        let label = if i == 0 { "keys" } else { "" };
        let taken = keys::user_binding(k.table, &k.key)
            .map(|b| s.yellow(&format!(" (yours is kept: {b})")))
            .unwrap_or_default();
        line(format!("  {label:<10}{}{taken}", describe_key(k)));
    }
    for (i, set) in m.settings.iter().enumerate() {
        let label = if i == 0 { "settings" } else { "" };
        line(format!("  {label:<10}{}", describe_setting(set)));
    }
    for (i, t) in m.themes.iter().enumerate() {
        let label = if i == 0 { "themes" } else { "" };
        line(format!("  {label:<10}{}", describe_theme(t)));
    }
    if !m.themes.is_empty() {
        line(s.yellow(
            "            a theme's CSS can restyle or hide any of the app, this prompt included",
        ));
    }
    for (i, d) in m.depends.iter().enumerate() {
        let label = if i == 0 { "depends" } else { "" };
        line(format!("  {label:<10}{}", describe_dependency(d)));
    }
    line(format!("  {:<10}{}", "platforms", platforms(m)));
    if let Some((old, _)) = subject.previous {
        let changes = diff(old, m);
        line(String::new());
        if changes.is_empty() {
            line("  changes   none to what it can do".to_string());
        }
        for (i, change) in changes.iter().enumerate() {
            let label = if i == 0 { "changes" } else { "" };
            line(format!("  {label:<10}{}", s.yellow(change)));
        }
    }
    out
}

fn platforms(m: &Manifest) -> String {
    m.platforms
        .as_ref()
        .map(|p| p.iter().map(|p| p.as_str()).collect::<Vec<_>>().join(", "))
        .unwrap_or_else(|| "any".to_string())
}

fn describe_link(h: &LinkHandler) -> String {
    match &h.matcher {
        LinkMatch::Url {
            hosts, path_regex, ..
        } => format!(
            "{}{} -> {}",
            hosts.join(", "),
            path_regex
                .as_deref()
                .map(|r| format!(" path {r}"))
                .unwrap_or_default(),
            h.action
        ),
        LinkMatch::Text { pattern } => format!("text {pattern} -> {}", h.action),
    }
}

fn describe_key(k: &Key) -> String {
    format!("{} {} -> {}", k.table.as_str(), k.key, k.action)
}

fn describe_setting(set: &Setting) -> String {
    let secret = if set.secret { ", secret" } else { "" };
    format!("{} ({}{secret})", set.key, set.kind.describe())
}

fn describe_theme(t: &Theme) -> String {
    format!("{}: {}", t.id, t.file)
}

fn describe_dependency(d: &Dependency) -> String {
    match &d.git_ref {
        Some(r) => format!("{} from {}@{r}", d.name, d.source),
        None => format!("{} from {}", d.name, d.source),
    }
}

/// One kind of entry an update can add, change or drop, matched across the
/// two manifests by `key`: `+ <what> <new>`, `~ <what> <new>`, `- <what> <key>`.
fn diff_entries<T: PartialEq>(
    changes: &mut Vec<String>,
    what: &str,
    old: &[T],
    new: &[T],
    key: impl Fn(&T) -> String,
    describe: impl Fn(&T) -> String,
) {
    for n in new {
        match old.iter().find(|o| key(o) == key(n)) {
            None => changes.push(format!("+ {what} {}", describe(n))),
            Some(was) if was != n => changes.push(format!("~ {what} {}", describe(n))),
            Some(_) => {}
        }
    }
    for o in old {
        if !new.iter().any(|n| key(n) == key(o)) {
            changes.push(format!("- {what} {}", key(o)));
        }
    }
}

/// What an update changes in what the plugin can do: every section the
/// table shows, so a new link handler, key, setting, theme or dependency is
/// never "none".
pub fn diff(old: &Manifest, new: &Manifest) -> Vec<String> {
    let mut changes = Vec::new();
    diff_entries(
        &mut changes,
        "action",
        &old.actions,
        &new.actions,
        |a| a.id.clone(),
        describe_action,
    );
    diff_entries(
        &mut changes,
        "verb",
        &old.cli,
        &new.cli,
        |c| format!("tmuxy plugin {}", c.verb),
        |c| format!("tmuxy plugin {}: {}", c.verb, c.command.join(" ")),
    );
    diff_entries(
        &mut changes,
        "requires",
        &old.requires,
        &new.requires,
        String::clone,
        String::clone,
    );
    diff_entries(
        &mut changes,
        "link",
        &old.link_handlers,
        &new.link_handlers,
        |h| h.id.clone(),
        |h| format!("{}: {}", h.id, describe_link(h)),
    );
    diff_entries(
        &mut changes,
        "key",
        &old.keys,
        &new.keys,
        |k| format!("{} {}", k.table.as_str(), k.key),
        describe_key,
    );
    diff_entries(
        &mut changes,
        "setting",
        &old.settings,
        &new.settings,
        |set| set.key.clone(),
        describe_setting,
    );
    diff_entries(
        &mut changes,
        "theme",
        &old.themes,
        &new.themes,
        |t| t.id.clone(),
        describe_theme,
    );
    diff_entries(
        &mut changes,
        "depends",
        &old.depends,
        &new.depends,
        |d| d.name.clone(),
        describe_dependency,
    );
    if old.platforms != new.platforms {
        changes.push(format!("~ platforms {}", platforms(new)));
    }
    changes
}

#[derive(Debug, Clone, Default)]
pub struct Answer {
    pub yes: bool,
    /// `--sha`, once per commit: the commits a `--yes` was given for.
    pub sha: Vec<String>,
}

/// Show the table and ask. `Ok(false)` is a no.
pub fn ask(subject: &Subject<'_>, answer: &Answer) -> Result<bool, PluginError> {
    ask_all(std::slice::from_ref(subject), answer)
}

fn sha_flags(commits: &[&str]) -> String {
    commits.iter().map(|sha| format!(" --sha {sha}")).collect()
}

/// A `--yes` stands for a review of exactly these commits: each one fetched
/// must be named, or a dependency that moved since would go in unseen.
fn reviewed(commits: &[&str], given: &[String]) -> Result<(), PluginError> {
    let unnamed: Vec<&str> = commits
        .iter()
        .filter(|sha| !given.iter().any(|g| g.eq_ignore_ascii_case(sha)))
        .copied()
        .collect();
    if unnamed.is_empty() {
        return Ok(());
    }
    if given.is_empty() {
        return Err(PluginError::Invalid(format!(
            "--yes needs --sha with every commit you reviewed:{}",
            sha_flags(commits)
        )));
    }
    Err(PluginError::Invalid(format!(
        "no --sha names {}: the source moved since it was reviewed, or a commit was left out; nothing installed",
        unnamed.join(", ")
    )))
}

/// One question for a plugin and the dependencies it brings: every table,
/// then one yes or no. A `--yes` names every commit shown with a `--sha`.
pub fn ask_all(subjects: &[Subject<'_>], answer: &Answer) -> Result<bool, PluginError> {
    if subjects.is_empty() {
        return Ok(true);
    }
    let render_all = |color: bool| {
        subjects
            .iter()
            .map(|s| render(s, color))
            .collect::<Vec<_>>()
            .join("\n")
    };
    let commits: Vec<&str> = subjects.iter().filter_map(|s| s.sha).collect();
    let on_stderr = || eprint!("{}", render_all(std::io::stderr().is_terminal()));
    if answer.yes {
        reviewed(&commits, &answer.sha)?;
        on_stderr();
        return Ok(true);
    }
    let Ok(tty) = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open("/dev/tty")
    else {
        // The table is the review a `--yes` stands for: show it where the
        // caller can read it before saying how to give one.
        on_stderr();
        return Err(PluginError::Invalid(format!(
            "no terminal to ask on; after reviewing the above, run again with --yes{}",
            sha_flags(&commits)
        )));
    };
    let mut writer = &tty;
    let question = if subjects.len() > 1 {
        "Install them?"
    } else {
        "Install it?"
    };
    let _ = write!(writer, "{}\n{question} [y/N] ", render_all(true));
    let _ = writer.flush();
    let mut reply = String::new();
    std::io::BufReader::new(&tty)
        .read_line(&mut reply)
        .map_err(|e| PluginError::io("reading the answer", e))?;
    Ok(matches!(reply.trim(), "y" | "Y" | "yes" | "Yes"))
}
