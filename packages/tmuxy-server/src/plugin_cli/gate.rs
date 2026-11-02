//! The install gate: what a plugin will be able to do, shown before any of
//! its code runs, and a yes asked of a person.
//!
//! The question goes to `/dev/tty`, never stdin, so `curl … | tmuxy plugin
//! install` cannot answer it. Without a terminal the gate fails closed unless
//! the caller passes `--yes --sha <commit>`: a script names the exact commit
//! it reviewed, never "whatever is there now".

use std::io::{BufRead, IsTerminal, Write};

use tmuxy_core::plugins::manifest::{Action, Manifest};
use tmuxy_core::plugins::registry::on_path;
use tmuxy_core::plugins::PluginError;

/// What is being installed, for the heading.
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
    let platforms = m
        .platforms
        .as_ref()
        .map(|p| p.iter().map(|p| p.as_str()).collect::<Vec<_>>().join(", "))
        .unwrap_or_else(|| "any".to_string());
    line(format!("  {:<10}{platforms}", "platforms"));
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

/// What an update changes in what the plugin can do.
pub fn diff(old: &Manifest, new: &Manifest) -> Vec<String> {
    let mut changes = Vec::new();
    for a in &new.actions {
        match old.action(&a.id) {
            None => changes.push(format!("+ action {}", describe_action(a))),
            Some(was) if was != a => changes.push(format!("~ action {}", describe_action(a))),
            Some(_) => {}
        }
    }
    for a in &old.actions {
        if new.action(&a.id).is_none() {
            changes.push(format!("- action {}", a.id));
        }
    }
    for c in &new.cli {
        match old.cli.iter().find(|o| o.verb == c.verb) {
            None => changes.push(format!(
                "+ verb tmuxy plugin {}: {}",
                c.verb,
                c.command.join(" ")
            )),
            Some(was) if was.command != c.command => changes.push(format!(
                "~ verb tmuxy plugin {}: {}",
                c.verb,
                c.command.join(" ")
            )),
            Some(_) => {}
        }
    }
    for c in &old.cli {
        if !new.cli.iter().any(|n| n.verb == c.verb) {
            changes.push(format!("- verb tmuxy plugin {}", c.verb));
        }
    }
    for r in &new.requires {
        if !old.requires.contains(r) {
            changes.push(format!("+ requires {r}"));
        }
    }
    changes
}

/// How the gate is answered.
#[derive(Debug, Clone, Default)]
pub struct Answer {
    /// `--yes`.
    pub yes: bool,
    /// `--sha`: the commit a `--yes` was given for.
    pub sha: Option<String>,
}

/// Show the table and ask. `Ok(false)` is a no.
pub fn ask(subject: &Subject<'_>, answer: &Answer) -> Result<bool, PluginError> {
    let color = std::io::stderr().is_terminal();
    if answer.yes {
        if let Some(sha) = subject.sha {
            match &answer.sha {
                Some(want) if want == sha => {}
                Some(want) => {
                    return Err(PluginError::Invalid(format!(
                    "--sha {want} was reviewed, but the source is at {sha} now; nothing installed"
                )))
                }
                None => {
                    return Err(PluginError::Invalid(format!(
                        "--yes needs --sha with the commit you reviewed (it is {sha})"
                    )))
                }
            }
        }
        eprint!("{}", render(subject, color));
        return Ok(true);
    }
    let tty = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open("/dev/tty")
        .map_err(|_| {
            PluginError::Invalid(match subject.sha {
                Some(sha) => format!(
                    "no terminal to ask on; after reviewing it, run again with --yes --sha {sha}"
                ),
                None => "no terminal to ask on; run again with --yes".to_string(),
            })
        })?;
    let mut writer = &tty;
    let _ = write!(writer, "{}\nInstall it? [y/N] ", render(subject, true));
    let _ = writer.flush();
    let mut reply = String::new();
    std::io::BufReader::new(&tty)
        .read_line(&mut reply)
        .map_err(|e| PluginError::io("reading the answer", e))?;
    Ok(matches!(reply.trim(), "y" | "Y" | "yes" | "Yes"))
}
