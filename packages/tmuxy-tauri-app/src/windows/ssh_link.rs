//! A splash window's ssh connection: the form it was given, and the one
//! authenticated connection every later ssh call for the window rides.
//!
//! tmuxy runs tmux through `ssh <tail> tmux …` once for control mode and again
//! for every read beside it, so a password typed once must not be asked for
//! again. The window gets an ssh config of its own: a `Host` block with what
//! the form filled in (user, port, key, certificate) and a control socket,
//! ahead of the user's `~/.ssh/config`, which still supplies everything else
//! (aliases, jumps, agents). A master connection is opened on that socket
//! before the window attaches, the only one that ever authenticates; the
//! password reaches it through an askpass helper reading a file only this
//! user can read, removed once the master is up. Every later call is a client
//! of the master, and the window's close ends it (`ssh -O exit`).
//!
//! A host whose key is not known is not trusted silently: the first attempt
//! is strict, and its fingerprint goes back to the page to be confirmed.

use std::fs;
use std::io::Write;
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde::Deserialize;
use tmuxy_core::session::is_ssh_destination;

/// How long a connection may take to authenticate before it is given up on.
const CONNECT_WAIT: Duration = Duration::from_secs(30);

/// What the splash page's ssh form sent. Every field but the host is optional:
/// left empty, ssh does as it would on its own (the agent, `~/.ssh` keys).
#[derive(Debug, Clone, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SshForm {
    pub host: String,
    #[serde(default)]
    pub user: Option<String>,
    #[serde(default)]
    pub port: Option<u16>,
    #[serde(default)]
    pub identity_file: Option<String>,
    #[serde(default)]
    pub certificate_file: Option<String>,
    /// The account's password, or the key's passphrase: whichever ssh asks for.
    #[serde(default)]
    pub password: Option<String>,
    /// The page confirmed the host's key fingerprint: trust it on first use.
    #[serde(default)]
    pub trust_new_host: bool,
}

/// A form that passed [`SshForm::checked`]: every value safe for an ssh config.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Checked {
    pub host: String,
    pub user: Option<String>,
    pub port: Option<u16>,
    pub identity_file: Option<PathBuf>,
    pub certificate_file: Option<PathBuf>,
    pub password: Option<String>,
    pub trust_new_host: bool,
}

fn filled(value: &Option<String>) -> Option<&str> {
    value.as_deref().map(str::trim).filter(|v| !v.is_empty())
}

/// `~/…` against the home directory; anything else as given.
fn expand_home(path: &str) -> PathBuf {
    match (path.strip_prefix("~/"), std::env::var_os("HOME")) {
        (Some(rest), Some(home)) => Path::new(&home).join(rest),
        _ => PathBuf::from(path),
    }
}

/// A key or certificate path the config can quote: absolute, an existing
/// file, and free of the quote and line breaks an ssh config cannot hold.
fn checked_file(what: &str, raw: &str) -> Result<PathBuf, String> {
    let path = expand_home(raw);
    let text = path.to_string_lossy();
    if !path.is_absolute() {
        return Err(format!("the {what} must be a full path: {raw}"));
    }
    if text.contains(['"', '\n', '\r']) {
        return Err(format!("the {what}'s path has a character ssh cannot take"));
    }
    if !path.is_file() {
        return Err(format!("no {what} at {}", path.display()));
    }
    Ok(path)
}

impl SshForm {
    /// The form as an ssh config can take it, or what is wrong with it. A
    /// `user@host` typed into the host field fills an empty user.
    pub fn checked(&self) -> Result<Checked, String> {
        let mut host = self.host.trim().to_string();
        let mut user = filled(&self.user).map(String::from);
        if let Some((typed_user, rest)) = host.clone().split_once('@') {
            if user.is_none() {
                user = Some(typed_user.to_string());
            }
            host = rest.to_string();
        }
        if host.is_empty() {
            return Err("a host to connect to".to_string());
        }
        // Host and user are written into a config and onto ssh's command line:
        // the same words a destination may be made of, never an option.
        let dest = match &user {
            Some(user) => format!("{user}@{host}"),
            None => host.clone(),
        };
        if host.contains(':') || !is_ssh_destination(&dest) {
            return Err(format!(
                "'{dest}' is not a host to connect to: a name or an address, with the port in its own field"
            ));
        }
        if self.port == Some(0) {
            return Err("the port is a number from 1 to 65535".to_string());
        }
        Ok(Checked {
            host,
            user,
            port: self.port,
            identity_file: filled(&self.identity_file)
                .map(|p| checked_file("key file", p))
                .transpose()?,
            certificate_file: filled(&self.certificate_file)
                .map(|p| checked_file("certificate", p))
                .transpose()?,
            password: self.password.clone().filter(|p| !p.is_empty()),
            trust_new_host: self.trust_new_host,
        })
    }
}

impl Checked {
    /// The window's ssh config: the form's `Host` block, read first so its
    /// values win, then the system's and the user's own config for the rest.
    pub fn config(&self, control_path: &Path) -> String {
        let mut out = format!(
            "# Written by tmuxy for one window, and removed when it closes.\nHost {}\n",
            self.host
        );
        if let Some(user) = &self.user {
            out.push_str(&format!("  User {user}\n"));
        }
        if let Some(port) = self.port {
            out.push_str(&format!("  Port {port}\n"));
        }
        if let Some(key) = &self.identity_file {
            out.push_str(&format!(
                "  IdentityFile \"{}\"\n  IdentitiesOnly yes\n",
                key.display()
            ));
        }
        if let Some(cert) = &self.certificate_file {
            out.push_str(&format!("  CertificateFile \"{}\"\n", cert.display()));
        }
        let strict = if self.trust_new_host {
            "accept-new"
        } else {
            "yes"
        };
        out.push_str(&format!(
            "  ControlMaster auto\n  ControlPath {}\n  StrictHostKeyChecking {strict}\n  ServerAliveInterval 30\n",
            control_path.display()
        ));
        out.push_str("Host *\n  Include ~/.ssh/config\n  Include /etc/ssh/ssh_config\n");
        out
    }
}

/// A window's open connection: its config and the host it names, the ssh
/// argv tail every tmux call for the window uses.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SshLink {
    pub config: PathBuf,
    pub host: String,
}

impl SshLink {
    /// `-F <config> <host>`: the tail `ssh_target` splits on whitespace, which
    /// neither part has (the directory is [`link_dir`], the host is checked).
    pub fn tail(&self) -> String {
        format!("-F {} {}", self.config.display(), self.host)
    }

    /// End the master connection and remove the window's files.
    pub fn close(&self) {
        let _ = Command::new("ssh")
            .args([
                "-F",
                &self.config.to_string_lossy(),
                "-O",
                "exit",
                &self.host,
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        let _ = fs::remove_file(&self.config);
    }
}

/// What opening a connection came to.
#[derive(Debug)]
pub enum Opened {
    Link(SshLink),
    /// The host's key is not known yet: its fingerprint, to be confirmed.
    UnknownHost {
        fingerprint: Option<String>,
    },
}

/// The directory a window's config, control socket and secrets live in:
/// `/tmp/tmuxy-ssh-<uid>`, short enough for a socket path on macOS, and
/// refused if anyone else made it or can read it.
fn link_dir() -> Result<PathBuf, String> {
    let uid = nix::unistd::getuid().as_raw();
    let dir = PathBuf::from(format!("/tmp/tmuxy-ssh-{uid}"));
    match fs::DirBuilder::new().mode(0o700).create(&dir) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(e) => return Err(format!("could not make {}: {e}", dir.display())),
    }
    let meta = fs::symlink_metadata(&dir).map_err(|e| e.to_string())?;
    if !meta.is_dir() || meta.uid() != uid || meta.mode() & 0o077 != 0 {
        return Err(format!(
            "{} is not this user's own private directory",
            dir.display()
        ));
    }
    Ok(dir)
}

/// Write `text` to `path`, readable by this user alone.
fn write_private(path: &Path, text: &str, mode: u32) -> Result<(), String> {
    let _ = fs::remove_file(path);
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(mode)
        .open(path)
        .map_err(|e| format!("could not write {}: {e}", path.display()))?;
    file.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
    fs::set_permissions(path, fs::Permissions::from_mode(mode)).map_err(|e| e.to_string())
}

/// Whether ssh refused for want of the host's key (strict checking).
pub fn is_unknown_host(stderr: &str) -> bool {
    (stderr.contains("host key is known") || stderr.contains("Host key verification failed"))
        && !stderr.contains("REMOTE HOST IDENTIFICATION HAS CHANGED")
}

/// The line of ssh's complaint worth showing: its last one that says something.
pub fn ssh_reason(stderr: &str) -> String {
    stderr
        .lines()
        .map(str::trim)
        .rfind(|l| !l.is_empty() && !l.starts_with("Warning: Permanently added"))
        .map(|l| format!("ssh: {l}"))
        .unwrap_or_else(|| "ssh could not connect".to_string())
}

/// The fingerprint of `host`'s key, as `ssh-keygen -l` prints it for what
/// `ssh-keyscan` fetched: the key type ssh asked about if it named one.
fn fingerprint(config: &Path, host: &str, stderr: &str) -> Option<String> {
    // Where the config sends the name: an alias's HostName and Port.
    let resolved = Command::new("ssh")
        .args(["-G", "-F", &config.to_string_lossy(), host])
        .stdin(Stdio::null())
        .output()
        .ok()?;
    let resolved = String::from_utf8_lossy(&resolved.stdout);
    let value = |key: &str| {
        resolved
            .lines()
            .find_map(|l| l.strip_prefix(key).map(|v| v.trim().to_string()))
    };
    let (name, port) = (value("hostname ")?, value("port ")?);
    let scan = Command::new("ssh-keyscan")
        .args(["-T", "5", "-p", &port, &name])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    let mut keygen = Command::new("ssh-keygen")
        .args(["-l", "-f", "-"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    keygen.stdin.take()?.write_all(&scan.stdout).ok()?;
    let listed = keygen.wait_with_output().ok()?;
    pick_fingerprint(&String::from_utf8_lossy(&listed.stdout), stderr)
}

/// From `ssh-keygen -l` lines (`256 SHA256:… host (ED25519)`), the one for the
/// key type ssh's complaint named, else the first, as `ED25519 SHA256:…`.
pub fn pick_fingerprint(listed: &str, stderr: &str) -> Option<String> {
    let entries: Vec<(String, String)> = listed
        .lines()
        .filter_map(|l| {
            let hash = l.split_whitespace().nth(1)?.to_string();
            let kind = l.rsplit_once('(')?.1.trim_end_matches(')').to_string();
            Some((kind, hash))
        })
        .collect();
    let wanted = entries
        .iter()
        .find(|(kind, _)| stderr.contains(&format!("No {kind} host key")))
        .or_else(|| entries.first())?;
    Some(format!("{} {}", wanted.0, wanted.1))
}

/// Open the window `label`'s connection: write its config, start the master
/// in the background once it has authenticated, and hand back the link, or
/// the host's fingerprint when its key is not known yet.
pub fn open(label: &str, form: &Checked) -> Result<Opened, String> {
    let dir = link_dir()?;
    let config = dir.join(format!("{label}.conf"));
    write_private(
        &config,
        &form.config(&dir.join(format!("{label}-%C"))),
        0o600,
    )?;
    let errors = dir.join(format!("{label}.err"));
    let secret = dir.join(format!("{label}.pass"));
    let askpass = dir.join("askpass");

    let mut ssh = Command::new("ssh");
    ssh.args(["-F", &config.to_string_lossy()])
        // `ControlMaster=yes` is the master; adding `-M` to it would make it
        // one that asks before it lets anyone end it, and so refuses `-O exit`.
        .args(["-o", "ControlMaster=yes", "-o", "ConnectTimeout=15"])
        .args(["-N", "-f", &form.host])
        .stdin(Stdio::null())
        .stdout(Stdio::null());
    match &form.password {
        Some(password) => {
            write_private(&secret, &format!("{password}\n"), 0o600)?;
            write_private(&askpass, "#!/bin/sh\ncat \"$TMUXY_SSH_SECRET\"\n", 0o700)?;
            ssh.env("SSH_ASKPASS", &askpass)
                .env("SSH_ASKPASS_REQUIRE", "force")
                .env("TMUXY_SSH_SECRET", &secret);
        }
        None => {
            ssh.args(["-o", "BatchMode=yes"])
                .env("SSH_ASKPASS_REQUIRE", "never");
        }
    }
    // A file, not a pipe: the master keeps ssh's stderr open after the
    // foreground process exits, and a pipe would never reach its end.
    let log = fs::File::create(&errors).map_err(|e| e.to_string())?;
    let outcome = run_until_backgrounded(ssh.stderr(log));
    let _ = fs::remove_file(&secret);
    let stderr = fs::read_to_string(&errors).unwrap_or_default();
    let _ = fs::remove_file(&errors);

    match outcome {
        Ok(true) => Ok(Opened::Link(SshLink {
            config,
            host: form.host.clone(),
        })),
        Ok(false) if !form.trust_new_host && is_unknown_host(&stderr) => {
            let fingerprint = fingerprint(&config, &form.host, &stderr);
            let _ = fs::remove_file(&config);
            Ok(Opened::UnknownHost { fingerprint })
        }
        Ok(false) => {
            let _ = fs::remove_file(&config);
            Err(ssh_reason(&stderr))
        }
        Err(e) => {
            let _ = fs::remove_file(&config);
            Err(e)
        }
    }
}

/// Run ssh until it goes to the background (`-f`: authenticated) or gives up.
fn run_until_backgrounded(ssh: &mut Command) -> Result<bool, String> {
    let mut child = ssh.spawn().map_err(|e| format!("could not run ssh: {e}"))?;
    let start = Instant::now();
    loop {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            return Ok(status.success());
        }
        if start.elapsed() > CONNECT_WAIT {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!(
                "no answer from the host in {}s",
                CONNECT_WAIT.as_secs()
            ));
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// The hosts the user's `~/.ssh/config` names, for the host field to offer:
/// every `Host` word that is a name rather than a pattern.
pub fn config_hosts() -> Vec<String> {
    let Some(home) = std::env::var_os("HOME") else {
        return Vec::new();
    };
    fs::read_to_string(Path::new(&home).join(".ssh/config"))
        .map(|text| hosts_in(&text))
        .unwrap_or_default()
}

/// The non-pattern `Host` names in an ssh config's text.
pub fn hosts_in(text: &str) -> Vec<String> {
    let mut hosts: Vec<String> = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        let Some((key, rest)) = line.split_once(|c: char| c.is_whitespace() || c == '=') else {
            continue;
        };
        if !key.eq_ignore_ascii_case("host") {
            continue;
        }
        for word in rest.split_whitespace() {
            let pattern = word.contains(['*', '?', '!']);
            if !pattern && is_ssh_destination(word) && !hosts.iter().any(|h| h == word) {
                hosts.push(word.to_string());
            }
        }
    }
    hosts
}

#[cfg(test)]
#[path = "ssh_link_tests.rs"]
mod tests;
