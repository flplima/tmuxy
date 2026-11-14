//! Where a verb reads the user's permissions file from, and whether the
//! caller runs where it says it does. Both are things the process being
//! judged would otherwise decide for itself.

use std::path::{Path, PathBuf};

use tmuxy_core::paths::Layout;
use tmuxy_core::session::{tmux_output, CONFIG_DIR_OPTION};

/// The permissions file a send is checked against: in the config directory
/// of the app that configured the tmux server, as the server holds it
/// ([`CONFIG_DIR_OPTION`]). The verb runs in the caller's process, so its own
/// `XDG_CONFIG_HOME` is the caller's to set, and a directory with no file in
/// it would be "no rules". A tmux server no tmuxy of this version configured
/// has no such option: the verb's own config directory is then all there is.
pub fn path() -> PathBuf {
    let argv = ["show-options", "-gqv", CONFIG_DIR_OPTION].map(String::from);
    from_option(&tmux_output(&argv).unwrap_or_default(), Layout::current())
}

fn from_option(value: &str, own: Layout) -> PathBuf {
    let dir = Path::new(value.trim_end_matches('\n'));
    if dir.is_absolute() {
        Layout {
            config: dir.to_path_buf(),
            ..own
        }
        .permissions()
    } else {
        own.permissions()
    }
}

/// Whether this process runs in the pane whose first process is `pane_pid`:
/// that process is this one or an ancestor of it. A caller that cannot show
/// it is treated as running in no pane, which only has its send asked.
pub fn runs_under(pane_pid: u32) -> bool {
    let mut pid = std::process::id();
    for _ in 0..128 {
        if pid <= 1 || pane_pid <= 1 {
            return false;
        }
        if pid == pane_pid {
            return true;
        }
        match parent_of(pid) {
            Some(parent) => pid = parent,
            None => return false,
        }
    }
    false
}

/// `/proc` where there is one, else `ps` (macOS).
fn parent_of(pid: u32) -> Option<u32> {
    if let Ok(status) = std::fs::read_to_string(format!("/proc/{pid}/status")) {
        return status
            .lines()
            .find_map(|line| line.strip_prefix("PPid:"))
            .and_then(|ppid| ppid.trim().parse().ok());
    }
    let output = std::process::Command::new("ps")
        .args(["-o", "ppid=", "-p", &pid.to_string()])
        .output()
        .ok()?;
    String::from_utf8_lossy(&output.stdout).trim().parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn layout() -> Layout {
        Layout {
            config: "/own/config".into(),
            data: "/d".into(),
            state: "/s".into(),
            home: "/h".into(),
        }
    }

    /// The tmux server's directory wins over the verb's own, and only a
    /// value that is a directory's full path is one.
    #[test]
    fn the_file_is_in_the_directory_the_tmux_server_names() {
        assert_eq!(
            from_option("/app/config/tmuxy\n", layout()),
            Path::new("/app/config/tmuxy/permissions.json")
        );
        for unset in ["", "\n", "relative/dir", "~/.config/tmuxy"] {
            assert_eq!(
                from_option(unset, layout()),
                Path::new("/own/config/permissions.json"),
                "{unset:?}"
            );
        }
    }

    #[test]
    fn a_process_runs_under_itself_and_its_ancestors_and_nothing_else() {
        let me = std::process::id();
        assert!(runs_under(me));
        let parent = parent_of(me).expect("a test process has a parent");
        assert!(runs_under(parent));
        // Process 1 is everyone's ancestor: a pane it "owns" proves nothing.
        assert!(!runs_under(1));
        assert!(!runs_under(0));
        // A child of this process is no ancestor of it.
        let mut child = std::process::Command::new("sleep")
            .arg("30")
            .spawn()
            .unwrap();
        assert!(!runs_under(child.id()));
        let _ = child.kill();
        let _ = child.wait();
    }
}
