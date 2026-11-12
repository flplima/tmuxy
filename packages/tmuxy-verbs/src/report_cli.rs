//! `tmuxy pane report`: a pane's report, for whoever started it.
//!
//! An agent in a pane says what it did with `tmuxy pane report <text>` (or
//! `-` for stdin); its orchestrator reads it with `tmuxy pane report -t
//! <pane>`, and `tmuxy agent wait --json` hands it over with the state. It
//! survives scrollback and a cleared screen, which a capture does not.
//!
//! The text is kept in a file of the state dir, keyed by socket and pane
//! (`reports/<socket>/<pane>.txt`, mode 0600), and `@tmuxy-report-at` on
//! the pane says when it was written. A report counts only while that
//! option is on its pane: the option goes with the pane, so a pane id a
//! later server hands out again never shows an old server's report.

use std::path::PathBuf;

use tmuxy_core::constants::tmux_options;
use tmuxy_core::paths::Layout;
use tmuxy_core::run_shell;

use crate::cli_json::{self, Answer, EXIT_FAILED, EXIT_TARGET, EXIT_USAGE};

/// The most a report keeps: a summary, not a log.
pub const MAX_REPORT_BYTES: usize = 64 * 1024;

#[derive(clap::Args, Debug)]
pub struct ReportArgs {
    /// Read this pane's report (an id: the shell resolves a label first).
    #[arg(short = 't', long = "target")]
    target: Option<String>,
    /// Write the report of this pane: the caller's own, as the shell
    /// verified it.
    #[arg(long, conflicts_with = "target")]
    own: Option<String>,
    /// The report; `-` reads it from stdin.
    text: Option<String>,
    #[arg(long)]
    json: bool,
}

/// A name that is safe as one path component.
fn component(name: &str) -> String {
    let safe: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
                c
            } else {
                '_'
            }
        })
        .collect();
    if safe.is_empty() || safe.starts_with('.') {
        format!("_{safe}")
    } else {
        safe
    }
}

/// Where `pane`'s report on `socket` is kept, under `state`.
pub fn report_path(state: &std::path::Path, socket: &str, pane: &str) -> PathBuf {
    state
        .join("reports")
        .join(component(socket))
        .join(format!("{}.txt", component(pane.trim_start_matches('%'))))
}

fn path_for(pane: &str) -> PathBuf {
    report_path(
        &tmuxy_core::paths::state_dir(),
        &tmuxy_core::session::tmux_socket(),
        pane,
    )
}

/// `text` cut to [`MAX_REPORT_BYTES`] on a character boundary.
pub fn capped(text: &str) -> &str {
    if text.len() <= MAX_REPORT_BYTES {
        return text;
    }
    let mut end = MAX_REPORT_BYTES;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

fn write_private(path: &std::path::Path, text: &str) -> std::io::Result<()> {
    use std::io::Write;
    let dir = path.parent().unwrap_or(path);
    std::fs::create_dir_all(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        for d in [dir, dir.parent().unwrap_or(dir)] {
            std::fs::set_permissions(d, std::fs::Permissions::from_mode(0o700))?;
        }
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(path)?;
        file.write_all(text.as_bytes())
    }
    #[cfg(not(unix))]
    {
        std::fs::write(path, text)
    }
}

/// When `pane`'s report was written (`@tmuxy-report-at`, Unix seconds), or
/// `None` when it has none or no pane answers.
fn written_at(pane: &str) -> Option<u64> {
    let format = format!("#{{{}}}", tmux_options::REPORT_AT);
    let read = ["display-message", "-p", "-t", pane, &format].map(String::from);
    tmuxy_core::session::tmux_output(&read)
        .ok()?
        .trim()
        .parse()
        .ok()
}

/// `pane`'s report and when it was written, if it has one.
pub fn read(pane: &str) -> Option<(String, u64)> {
    let at = written_at(pane)?;
    let text = std::fs::read(path_for(pane)).ok()?;
    Some((
        String::from_utf8_lossy(capped_bytes(&text)).into_owned(),
        at,
    ))
}

fn capped_bytes(bytes: &[u8]) -> &[u8] {
    &bytes[..bytes.len().min(MAX_REPORT_BYTES)]
}

fn pane_exists(pane: &str) -> bool {
    let read = ["display-message", "-p", "-t", pane, "#{pane_id}"].map(String::from);
    tmuxy_core::session::tmux_output(&read)
        .map(|out| out.trim() == pane)
        .unwrap_or(false)
}

pub fn run(args: ReportArgs) {
    let answer = Answer::new(args.json);
    if let Some(pane) = &args.target {
        if args.text.is_some() {
            answer.exit(
                EXIT_USAGE,
                "a report is its own pane's to write: -t only reads one",
            );
        }
        if !pane_exists(pane) {
            answer.exit(EXIT_TARGET, &format!("no pane {pane}"));
        }
        let Some((text, at)) = read(pane) else {
            answer.exit(EXIT_FAILED, &format!("{pane} has no report"))
        };
        return answer.done(
            &[
                ("paneId", cli_json::string(pane)),
                ("report", cli_json::string(&text)),
                ("at", at.to_string()),
            ],
            text.trim_end(),
        );
    }
    let Some(own) = args.own else {
        answer.exit(EXIT_USAGE, "run this inside the pane the report is about")
    };
    let text = match args.text.as_deref() {
        None => answer.exit(EXIT_USAGE, "the report is required (or - for stdin)"),
        Some("-") => {
            use std::io::Read;
            let mut input = Vec::new();
            let _ = std::io::stdin()
                .take(MAX_REPORT_BYTES as u64)
                .read_to_end(&mut input);
            String::from_utf8_lossy(&input).into_owned()
        }
        Some(text) => capped(text).to_string(),
    };
    if let Err(e) = write_private(&path_for(&own), &text) {
        answer.exit(EXIT_FAILED, &format!("could not keep the report: {e}"));
    }
    let at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or_default();
    let set = [
        "set-option",
        "-p",
        "-t",
        &own,
        tmux_options::REPORT_AT,
        &at.to_string(),
    ]
    .map(String::from);
    if let Err(e) = run_shell::tmux(&Layout::current(), &set) {
        crate::run_cli::fail_to_run(&answer, e);
    }
    answer.done(
        &[
            ("paneId", cli_json::string(&own)),
            ("bytes", text.len().to_string()),
        ],
        "",
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_report_is_kept_per_socket_and_pane_in_safe_names() {
        let state = std::path::Path::new("/s");
        assert_eq!(
            report_path(state, "tmuxy", "%12"),
            PathBuf::from("/s/reports/tmuxy/12.txt")
        );
        assert_eq!(
            report_path(state, "../../etc", "%1/../x"),
            PathBuf::from("/s/reports/_.._.._etc/1_.._x.txt")
        );
        assert_eq!(component(""), "_");
    }

    #[test]
    fn a_long_report_is_cut_on_a_character_boundary() {
        let text = "é".repeat(MAX_REPORT_BYTES);
        let cut = capped(&text);
        assert!(cut.len() <= MAX_REPORT_BYTES);
        assert!(cut.len() > MAX_REPORT_BYTES - 2);
        assert_eq!(capped("short"), "short");
    }

    #[test]
    fn a_report_file_is_private() {
        let dir = std::env::temp_dir().join(format!("tmuxy-report-{}", std::process::id()));
        let path = report_path(&dir, "sock", "%3");
        write_private(&path, "done").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "done");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode =
                |p: &std::path::Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode(&path), 0o600);
            assert_eq!(mode(path.parent().unwrap()), 0o700);
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
