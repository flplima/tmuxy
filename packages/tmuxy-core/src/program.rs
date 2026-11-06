//! What a pane's program is called. tmux names a process by the file it runs
//! (the kernel's `p_comm`), not by the name it was invoked as, and Claude Code
//! runs as `…/claude/versions/<version>`: tmux reports a bare version
//! (`2.1.314`) for it. Every surface that names a pane's program — the state
//! the clients draw, a send's caller and the allow lists, the agent screen
//! watch, a push notice — names it through [`program_name`].

/// The program `command` (a `#{pane_current_command}`) is: `claude` for a
/// command that is nothing but a dotted version number, which no real
/// executable is called, else the command itself.
pub fn program_name(command: &str) -> &str {
    if is_version(command) {
        "claude"
    } else {
        command
    }
}

fn is_version(value: &str) -> bool {
    value.contains('.')
        && value
            .split('.')
            .all(|part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit()))
}

#[cfg(test)]
mod tests {
    use super::program_name;

    #[test]
    fn a_version_number_is_claude_code_and_anything_else_is_itself() {
        assert_eq!(program_name("2.1.314"), "claude");
        assert_eq!(program_name("0.9"), "claude");
        assert_eq!(program_name("agy"), "agy");
        assert_eq!(program_name("zsh"), "zsh");
        assert_eq!(program_name("python3.12"), "python3.12");
        assert_eq!(program_name("5"), "5");
        assert_eq!(program_name("1..2"), "1..2");
        assert_eq!(program_name(""), "");
    }
}
