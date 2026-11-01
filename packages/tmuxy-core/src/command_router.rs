//! The one routing policy for commands a client asks tmuxy to run.
//!
//! Both transports — the web server's `RunTmuxCommand` and `QueryTmux`
//! handlers and the desktop app's `run_tmux_command` and `query_tmux` — call
//! [`route_command`] or [`route_query`] and then do only mechanics with the
//! answer (write to their monitor's command channel). The policy used to be
//! duplicated per transport, and had drifted: the desktop ran every
//! single-line command as an external subprocess with a session-target
//! rewrite that overrode the frontend's window/pane pin, so a split could
//! land on whatever tab tmux happened to be on. A policy that exists once
//! cannot diverge.
//!
//! What the policy says, of every command a client sends — each control-mode
//! line of it, and each command of each line, wherever tmux would split them,
//! inside `{ … }` blocks too (X5 in `docs/INVARIANTS.md`):
//! - `resize-window` is refused: sizing goes through `set_client_size`, which
//!   reconciles every client's viewport; a raw resize from one client would
//!   override the others (and a stale connection's).
//! - `new-window` is rewritten to `splitw ; breakp`, keeping any pin around
//!   it (and in place, inside a block): `new-window` crashes tmux 3.5a with a
//!   control-mode client attached.
//! - a blank line is left out: an empty line detaches the control-mode
//!   client, which is the monitor's own connection.
//! - everything else goes to control mode **byte-identical**. No target is
//!   ever added: an untargeted command after a `select-window ; select-pane`
//!   pin inherits the queue's current target, which is exactly what the pin
//!   established, whereas a session target is resolved late against the
//!   session's live current window and loses a race with any other client.
//!
//! A query runs only commands that read (X6): a mutation sent as a query
//! skipped what the mutation path does around it — the queue that keeps a
//! client's mutations in order, the `run-shell` relay that keeps tmux 3.4 out
//! of a view-mode tmuxy does not draw, the report of an `%error`. None of
//! this is an access boundary: a client may run any command it likes, as a
//! mutation.

use crate::control_mode::control_mode_lines;
use crate::executor::{
    command_verb, compound_runs, every_command, rewrite_mutating_verbs,
    rewrite_new_window_in_compound, NEW_WINDOW, RESIZE_WINDOW,
};

/// Where a client's command goes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Route {
    /// Not run at all; the reason is for the log.
    Blocked(&'static str),
    /// Sent down the monitor's control-mode connection as-is.
    ControlMode(String),
}

/// The commands a query may run: tmux's reads, by name and alias.
const READ_VERBS: &[&str] = &[
    "capture-pane",
    "capturep",
    "display-message",
    "display",
    "has-session",
    "has",
    "list-buffers",
    "lsb",
    "list-clients",
    "lsc",
    "list-commands",
    "lscm",
    "list-keys",
    "lsk",
    "list-panes",
    "lsp",
    "list-sessions",
    "ls",
    "list-windows",
    "lsw",
    "show-buffer",
    "showb",
    "show-environment",
    "showenv",
    "show-hooks",
    "show-messages",
    "showmsgs",
    "show-options",
    "show",
    "show-prompt-history",
    "showphist",
    "show-window-options",
    "showw",
];

/// Decide the route for a command. `size` is the viewport a freshly created
/// window should be sized to, when one client has reported one.
pub fn route_command(command: &str, session: &str, size: Option<(u32, u32)>) -> Route {
    let mut lines = Vec::new();
    for line in control_mode_lines(command) {
        if compound_runs(line, &RESIZE_WINDOW) {
            return Route::Blocked("resize-window must go through set_client_size");
        }
        let rewritten = if compound_runs(line, &NEW_WINDOW) {
            rewrite_new_window_in_compound(line, session, size)
        } else {
            None
        };
        lines.push(rewritten.unwrap_or_else(|| rewrite_mutating_verbs(line)));
    }
    if lines.is_empty() {
        return Route::Blocked("empty command");
    }
    Route::ControlMode(lines.join("\n"))
}

/// Decide the route for a query: as it came when every command in it reads,
/// refused otherwise.
pub fn route_query(command: &str) -> Route {
    let verbs: Vec<String> = control_mode_lines(command)
        .flat_map(every_command)
        .filter_map(|part| {
            Some(command_verb(part))
                .filter(|v| !v.is_empty())
                .map(str::to_string)
        })
        .collect();
    if verbs.is_empty() {
        return Route::Blocked("empty command");
    }
    if !verbs.iter().all(|verb| READ_VERBS.contains(&verb.as_str())) {
        return Route::Blocked("a query only reads; send a mutation with run_tmux_command");
    }
    Route::ControlMode(command.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_pinned_list_reaches_tmux_untouched() {
        // The regression: the frontend pins a split to the tab the user sees.
        // Any rewrite of the final command — a session target in particular —
        // hands the split to whatever window tmux is on when it runs.
        let pinned =
            "select-window -t @19 \\; select-pane -t %48 \\; splitw -h -c \"#{pane_current_path}\"";
        assert_eq!(
            route_command(pinned, "tmuxy", None),
            Route::ControlMode(pinned.to_string())
        );
    }

    #[test]
    fn mutating_verbs_are_normalized_to_short_forms() {
        assert_eq!(
            route_command("split-window -h", "tmuxy", None),
            Route::ControlMode("splitw -h".to_string())
        );
        assert_eq!(
            route_command("kill-pane -t %1", "tmuxy", None),
            Route::ControlMode("killp -t %1".to_string())
        );
        assert_eq!(
            route_command("kill-window -t @2", "tmuxy", None),
            Route::ControlMode("killw -t @2".to_string())
        );
        assert_eq!(
            route_command("break-pane -d", "tmuxy", None),
            Route::ControlMode("breakp -d".to_string())
        );
        let pinned = "select-window -t @19 \\; select-pane -t %48 \\; split-window -h -c \"#{pane_current_path}\"";
        assert_eq!(
            route_command(pinned, "tmuxy", None),
            Route::ControlMode(
                "select-window -t @19 ; select-pane -t %48 ; splitw -h -c \"#{pane_current_path}\""
                    .to_string()
            )
        );
    }

    #[test]
    fn an_untargeted_command_gets_no_target() {
        for cmd in ["splitw -v", "copy-mode", "send-keys -l 'x'", "killp"] {
            assert_eq!(
                route_command(cmd, "tmuxy", None),
                Route::ControlMode(cmd.to_string())
            );
        }
    }

    #[test]
    fn resize_window_is_refused_wherever_it_sits_in_the_list() {
        assert!(matches!(
            route_command("resize-window -x 80 -y 24", "tmuxy", None),
            Route::Blocked(_)
        ));
        assert!(matches!(
            route_command("select-window -t @1 \\; resizew -x 80 -y 24", "tmuxy", None),
            Route::Blocked(_)
        ));
    }

    #[test]
    fn new_window_is_rewritten_and_keeps_its_pin() {
        let routed = route_command(
            "select-window -t @2 \\; select-pane -t %5 \\; new-window",
            "tmuxy",
            Some((120, 40)),
        );
        let Route::ControlMode(cmd) = routed else {
            panic!("new-window must route to control mode, got {routed:?}");
        };
        assert!(
            cmd.starts_with("select-window -t @2 ; select-pane -t %5 ;"),
            "{cmd}"
        );
        assert!(cmd.contains("splitw") && cmd.contains("breakp"), "{cmd}");
        assert!(!cmd.contains("new-window"), "{cmd}");
        assert!(cmd.contains("resizew -x 120 -y 40"), "{cmd}");
    }

    /// X5: whatever way a command list is written, the policy sees each of
    /// its commands — each of these once reached tmux unrefused.
    #[test]
    fn resize_window_is_refused_however_the_list_is_written() {
        for cmd in [
            "select-pane -t %1\nresizew -x 1 -y 1",
            "select-pane -t %1 ; resizew -x 1 -y 1",
            "display \"\\\"\" \\; resizew -x 1 -y 1",
            "display \\' \\; resizew -x 1 -y 1",
            "resize-w -x 1 -y 1",
            "if-shell -F 1 { resizew -x 10 -y 10 }",
            "select-pane -t %1 \\; if -F 1 { display x } { if -F 1 { resize-w -x 1 } }",
        ] {
            assert!(
                matches!(route_command(cmd, "tmuxy", None), Route::Blocked(_)),
                "{cmd:?}"
            );
        }
    }

    /// X5: a `new-window` on any line, or after a bare `;`, is rewritten like
    /// one after `\;`; the lines around it go out as they came.
    #[test]
    fn new_window_is_rewritten_on_whatever_line_it_sits() {
        for cmd in [
            "display-message -p x\nnew-window",
            "display-message -p x ; neww",
            "display-message -p x ; new-w",
        ] {
            let Route::ControlMode(routed) = route_command(cmd, "tmuxy", None) else {
                panic!("{cmd:?} routes");
            };
            assert!(routed.starts_with("display-message -p x"), "{routed:?}");
            assert!(routed.contains("splitw -t 'tmuxy' ; breakp"), "{routed:?}");
            assert!(
                !routed.contains("new-w") && !routed.contains("neww"),
                "{routed:?}"
            );
        }
    }

    /// X5: a `new-window` inside a `{ … }` block — a conditional binding, a
    /// menu item — is rewritten in place, and the block keeps its shape. A
    /// binding with blocks and nothing to rewrite reaches tmux untouched.
    #[test]
    fn brace_blocks_are_routed_whole() {
        assert_eq!(
            route_command(
                "select-pane -t %5 \\; if-shell -F 1 { new-window }",
                "tmuxy",
                None
            ),
            Route::ControlMode(
                "select-pane -t %5 ; if-shell -F 1 { splitw -t 'tmuxy' ; breakp }".to_string()
            )
        );
        let binding = "select-window -t @1 \\; select-pane -t %1 \\; if-shell -F -t = \
                       \"#{||:#{mouse_any_flag},#{pane_in_mode}}\" { select-pane -t = ; send-keys -M } \
                       { display-menu -x M Kill X { kill-pane } Float f { break-pane -W } }";
        assert_eq!(
            route_command(binding, "tmuxy", None),
            Route::ControlMode(binding.to_string())
        );
    }

    /// Typed text is one `send-keys` per line, and reaches tmux line for line;
    /// a blank line never does — an empty line detaches the control client.
    #[test]
    fn lines_go_out_as_they_came_and_blank_ones_not_at_all() {
        let typed = "send-keys -t %3 -l -- 'a;b'\nsend-keys -t %3 Enter\nsend-keys -t %3 -l -- 'c'";
        assert_eq!(
            route_command(typed, "tmuxy", None),
            Route::ControlMode(typed.to_string())
        );
        assert_eq!(
            route_command(
                "display-message -p a\n\n  \ndisplay-message -p b\n",
                "tmuxy",
                None
            ),
            Route::ControlMode("display-message -p a\ndisplay-message -p b".to_string())
        );
        for blank in ["", "\n", " \n\n"] {
            assert!(
                matches!(route_command(blank, "tmuxy", None), Route::Blocked(_)),
                "{blank:?}"
            );
        }
    }

    /// X6: every read the app and its tests send as a query still routes, as
    /// it came.
    #[test]
    fn a_query_that_reads_routes_as_it_came() {
        for query in [
            "display-message -p caught-up",
            "display-message -p -F '#{socket_path}'",
            "display -p -t %9 \"#{pane_id}\"",
            "show-environment -g TMUXY_SWITCH_TO",
            "list-windows -a -F '#{session_name} #{window_id}'",
            "list-panes -a -F '#{pane_id}\t#{window_id}'",
            "list-panes -t @3",
            "capture-pane -p -e -t %1 -S -10 -E 0",
            "show-options -gqv @x \\; list-keys -T root",
        ] {
            assert_eq!(
                route_query(query),
                Route::ControlMode(query.to_string()),
                "{query:?}"
            );
        }
    }

    /// X6: a query that would change anything — on its own, later in the
    /// list, or on another line — is refused; it belongs to
    /// `run_tmux_command`.
    #[test]
    fn a_query_that_would_change_anything_is_refused() {
        for query in [
            "run-shell 'echo hi'",
            "new-window",
            "resizew -x 10",
            "kill-server",
            "display-message -p x ; kill-pane",
            "display-message -p x \\; run-shell true",
            "display-message -p x\nsend-keys -t %1 y",
            "display-m -p x",
            "display-message -p x { kill-pane }",
            "",
            "\n",
        ] {
            assert!(matches!(route_query(query), Route::Blocked(_)), "{query:?}");
        }
    }
}
