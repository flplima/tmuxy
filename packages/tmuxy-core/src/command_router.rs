//! The one routing policy for commands a client asks tmuxy to run.
//!
//! Both transports — the web server's `RunTmuxCommand` handler and the
//! desktop app's `run_tmux_command` — call [`route_command`] and then do only
//! mechanics with the answer (write to their monitor's command channel). The
//! policy used to be duplicated per transport, and had drifted: the desktop
//! ran every single-line command as an external subprocess with a
//! session-target rewrite that overrode the frontend's window/pane pin, so a
//! split could land on whatever tab tmux happened to be on. A policy that
//! exists once cannot diverge.
//!
//! What the policy says:
//! - `resize-window` is refused: sizing goes through `set_client_size`, which
//!   reconciles every client's viewport; a raw resize from one client would
//!   override the others (and a stale connection's).
//! - `new-window` is rewritten to `splitw ; breakp`, keeping any pin around
//!   it: `new-window` crashes tmux 3.5a with a control-mode client attached.
//! - everything else goes to control mode **byte-identical**. No target is
//!   ever added: an untargeted command after a `select-window ; select-pane`
//!   pin inherits the queue's current target, which is exactly what the pin
//!   established, whereas a session target is resolved late against the
//!   session's live current window and loses a race with any other client.

use crate::executor::{compound_has_verb, rewrite_new_window_in_compound};

/// Where a client's command goes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Route {
    /// Not run at all; the reason is for the log.
    Blocked(&'static str),
    /// Sent down the monitor's control-mode connection as-is.
    ControlMode(String),
}

/// Decide the route for a command. `size` is the viewport a freshly created
/// window should be sized to, when one client has reported one.
pub fn route_command(command: &str, session: &str, size: Option<(u32, u32)>) -> Route {
    if compound_has_verb(command, &["resize-window", "resizew"]) {
        return Route::Blocked("resize-window must go through set_client_size");
    }
    if compound_has_verb(command, &["new-window", "neww"]) {
        if let Some(rewritten) = rewrite_new_window_in_compound(command, session, size) {
            return Route::ControlMode(rewritten);
        }
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
        let pinned = "select-window -t @19 \\; select-pane -t %48 \\; split-window -h -c \"#{pane_current_path}\"";
        assert_eq!(
            route_command(pinned, "tmuxy", None),
            Route::ControlMode(pinned.to_string())
        );
    }

    #[test]
    fn an_untargeted_command_gets_no_target() {
        for cmd in [
            "split-window -v",
            "copy-mode",
            "send-keys -l 'x'",
            "kill-pane",
        ] {
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
}
