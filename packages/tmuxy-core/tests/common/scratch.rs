//! A tmux server of the test's own, on `tmuxy-<name>-<pid>`, a socket no real
//! session uses, with a home directory of its own beside it. Killed on drop,
//! a failed assert included, so a red run leaves no tmux behind.
//!
//! The one scratch-server fixture of the workspace: tmuxy-core's tests use
//! it from `common`, tmuxy-server's include this file by path.

#![allow(dead_code)]

use std::path::PathBuf;

pub struct ScratchServer {
    pub socket: String,
    /// A home of the test's own, for a binary that reads or writes tmuxy's dirs.
    pub home: PathBuf,
}

impl ScratchServer {
    /// The socket and home, with no server started yet and this process's
    /// environment untouched: a test hands the socket to what it runs.
    pub fn new(name: &str) -> Self {
        let socket = format!("tmuxy-{name}-{}", std::process::id());
        let home = std::env::temp_dir().join(&socket);
        std::fs::create_dir_all(&home).unwrap();
        Self { socket, home }
    }

    /// Session `work`, `cols` by `rows`, with no config read.
    pub fn with_session(name: &str, cols: u16, rows: u16) -> Self {
        let server = Self::new(name);
        let (cols, rows) = (cols.to_string(), rows.to_string());
        server.tmux(&[
            "-f",
            "/dev/null",
            "new-session",
            "-d",
            "-s",
            "work",
            "-x",
            &cols,
            "-y",
            &rows,
        ]);
        // A tmux server keeps the environment it was started in and hands it
        // to every hook and `run-shell` job. A `TMUX_SOCKET` the shell
        // exported would name another server there: the CLI a hook runs goes
        // by it before `$TMUX`, and the hook then works on the wrong socket.
        server.tmux(&["set-environment", "-g", "-u", "TMUX_SOCKET"]);
        server
    }

    /// [`Self::new`], and tmuxy-core in this process pointed at it through
    /// `TMUX_SOCKET`, with its state dir (where a connect writes the entry
    /// file tmux starts from) in the server's home, never the developer's.
    /// The variables are process-wide, so a test binary holds one test that
    /// does this: there is nothing to race.
    pub fn process_wide(name: &str) -> Self {
        let server = Self::new(name);
        std::env::set_var("TMUX_SOCKET", &server.socket);
        std::env::set_var("TMUXY_STATE_DIR", server.home.join("state"));
        server
    }

    /// One tmux command on this server, which must succeed: its stdout, trimmed.
    pub fn tmux(&self, args: &[&str]) -> String {
        let out = tmuxy_core::session::local_tmux_on(&self.socket)
            .args(args)
            .output()
            .expect("tmux runs");
        assert!(
            out.status.success(),
            "tmux {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }
}

impl Drop for ScratchServer {
    fn drop(&mut self) {
        let _ = tmuxy_core::session::local_tmux_on(&self.socket)
            .arg("kill-server")
            .output();
        let _ = std::fs::remove_dir_all(&self.home);
    }
}
