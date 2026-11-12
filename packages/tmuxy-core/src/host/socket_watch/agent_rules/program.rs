//! The program behind a pane, when tmux names only its interpreter.
//!
//! tmux names a pane's command after the foreground process group's leader,
//! its `argv[0]`. An agent written in Node or Python and started from its
//! bin script (`#!/usr/bin/env node`) is then `node` or `python3`, unless it
//! sets its own process title. For an interpreter, the script it runs names
//! the program instead: `node ~/.npm/bin/gemini` is `gemini`, and
//! `python3 -m aider` is `aider`.
//!
//! The arguments come from `/proc`, read only; elsewhere the command stands
//! as tmux names it.

/// The commands that run a program named by their arguments.
const INTERPRETERS: [&str; 11] = [
    "node", "nodejs", "bun", "deno", "python", "python3", "ruby", "perl", "sh", "bash", "dash",
];

pub fn is_interpreter(command: &str) -> bool {
    INTERPRETERS.contains(&command)
        || command
            .strip_prefix("python3.")
            .is_some_and(|minor| !minor.is_empty() && minor.bytes().all(|b| b.is_ascii_digit()))
}

/// The script an interpreter's `argv` runs, by its file name without an
/// extension, or the module after `-m`. `None` for inline code (`-c`, `-e`)
/// or no script at all (a REPL, a shell at its prompt).
pub fn script_name(argv: &[String]) -> Option<String> {
    let mut args = argv.iter().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "-m" => return args.next().cloned(),
            "-c" | "-e" | "--eval" | "-p" | "--print" => return None,
            flag if flag.starts_with('-') => continue,
            path => {
                let name = path.rsplit('/').next().unwrap_or(path);
                let stem = [".js", ".mjs", ".cjs", ".ts", ".py"]
                    .iter()
                    .find_map(|ext| name.strip_suffix(ext))
                    .unwrap_or(name);
                return (!stem.is_empty()).then(|| stem.to_string());
            }
        }
    }
    None
}

/// The foreground process group leader's `argv` on the terminal of the
/// pane whose first process is `pane_pid`: the process tmux names the pane's
/// command after.
#[cfg(target_os = "linux")]
fn foreground_argv(pane_pid: u32) -> Option<Vec<String>> {
    let stat = std::fs::read_to_string(format!("/proc/{pane_pid}/stat")).ok()?;
    // The fields after the command's closing parenthesis: state, ppid,
    // pgrp, session, tty_nr, tpgid.
    let tpgid: i64 = stat
        .rsplit_once(')')?
        .1
        .split_whitespace()
        .nth(5)?
        .parse()
        .ok()?;
    if tpgid <= 0 {
        return None;
    }
    let cmdline = std::fs::read(format!("/proc/{tpgid}/cmdline")).ok()?;
    Some(
        cmdline
            .split(|b| *b == 0)
            .filter(|arg| !arg.is_empty())
            .map(|arg| String::from_utf8_lossy(arg).into_owned())
            .collect(),
    )
}

#[cfg(not(target_os = "linux"))]
fn foreground_argv(_pane_pid: u32) -> Option<Vec<String>> {
    None
}

fn pane_pid(pane: &str) -> Option<u32> {
    let output = crate::session::tmux_command()
        .args(["display-message", "-p", "-t", pane, "#{pane_pid}"])
        .output()
        .ok()?;
    String::from_utf8_lossy(&output.stdout).trim().parse().ok()
}

/// The program in `pane`, given the command tmux names: the interpreter's
/// script when there is one, else the command.
pub fn program(pane: &str, command: &str) -> String {
    if !is_interpreter(command) {
        return command.to_string();
    }
    pane_pid(pane)
        .and_then(foreground_argv)
        .and_then(|argv| script_name(&argv))
        .unwrap_or_else(|| command.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn name(argv: &[&str]) -> Option<String> {
        script_name(&argv.iter().map(|a| a.to_string()).collect::<Vec<_>>())
    }

    #[test]
    fn an_interpreter_is_named_after_its_script() {
        assert_eq!(
            name(&["node", "/home/u/.npm/bin/gemini"]).as_deref(),
            Some("gemini")
        );
        assert_eq!(
            name(&[
                "node",
                "--no-warnings",
                "/usr/lib/amp/dist/amp.js",
                "--resume"
            ])
            .as_deref(),
            Some("amp")
        );
        assert_eq!(
            name(&["python3", "-m", "aider", "--model", "x"]).as_deref(),
            Some("aider")
        );
        assert_eq!(
            name(&["python3", "/usr/local/bin/aider"]).as_deref(),
            Some("aider")
        );
        assert_eq!(name(&["sh", "./gemini"]).as_deref(), Some("gemini"));
    }

    #[test]
    fn inline_code_or_no_script_names_nothing() {
        assert_eq!(name(&["node"]), None);
        assert_eq!(name(&["node", "-e", "console.log(1)"]), None);
        assert_eq!(name(&["bash", "-c", "gemini"]), None);
        assert_eq!(name(&["-zsh"]), None);
    }

    #[test]
    fn interpreters_are_known_and_programs_are_not() {
        for interpreter in ["node", "python3", "python3.12", "bun", "sh"] {
            assert!(is_interpreter(interpreter), "{interpreter}");
        }
        for program in ["gemini", "aider", "python3.x", "python3.", "nvim", "zsh"] {
            assert!(!is_interpreter(program), "{program}");
        }
    }
}
