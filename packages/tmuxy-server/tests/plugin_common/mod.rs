#![allow(dead_code)]

use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};

pub struct Scratch {
    pub base: PathBuf,
}

impl Scratch {
    pub fn new(tag: &str) -> Self {
        let base = std::env::temp_dir().join(format!(
            "tmuxy-plugin-it-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&base).unwrap();
        Scratch { base }
    }

    pub fn path(&self, rel: &str) -> PathBuf {
        self.base.join(rel)
    }

    pub fn tmuxy(&self, args: &[&str]) -> Output {
        Command::new(env!("CARGO_BIN_EXE_tmuxy-server"))
            .arg("plugin")
            .args(args)
            .env("HOME", self.path("home"))
            .env("XDG_CONFIG_HOME", self.path("home/.config"))
            .env("TMUXY_STATE_DIR", self.path("state"))
            .env(
                "TMUXY_PLUGIN_GIT_BASE",
                format!("file://{}", self.path("remote").display()),
            )
            .env("TMUX_SOCKET", self.path("no-such-socket"))
            .env("TMUXY_PLUGIN_INDEX", self.path("index.json"))
            .env_remove("TMUX")
            .env_remove("TMUX_PANE")
            .current_dir(self.path("home"))
            .stdin(Stdio::null())
            .output()
            .unwrap()
    }

    pub fn lockfile(&self) -> serde_json::Value {
        let text = std::fs::read_to_string(self.path("home/.config/tmuxy/plugins.json")).unwrap();
        serde_json::from_str(&text).unwrap()
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.base);
    }
}

pub fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .args([
            "-c",
            "user.name=t",
            "-c",
            "user.email=t@t",
            "-c",
            "init.defaultBranch=main",
        ])
        .args(args)
        .current_dir(dir)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

pub fn stderr(out: &Output) -> String {
    String::from_utf8_lossy(&out.stderr).into_owned()
}

/// A repository `owner/name` under `remote/` holding `files` (path, text,
/// executable), committed; returns its head commit.
pub fn repo(s: &Scratch, owner: &str, name: &str, files: &[(&str, &str, bool)]) -> String {
    let repo = s.path(&format!("remote/{owner}/{name}.git"));
    std::fs::create_dir_all(&repo).unwrap();
    git(&repo, &["init", "-q"]);
    git(&repo, &["config", "uploadpack.allowAnySHA1InWant", "true"]);
    for (rel, text, exec) in files {
        let path = repo.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, text).unwrap();
        #[cfg(unix)]
        if *exec {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
    }
    git(&repo, &["add", "-A"]);
    git(&repo, &["commit", "-q", "-m", "plugin"]);
    git(&repo, &["rev-parse", "HEAD"])
}

pub fn stdout(out: &Output) -> String {
    String::from_utf8_lossy(&out.stdout).into_owned()
}
