//! `tmuxy server install`: what keeps the web server running at login and boot,
//! as pure data. The unit or plist text, the commands to run and the checks
//! that refuse an install are built here and tested without touching the
//! machine; `service_cli` runs them.

use std::path::{Path, PathBuf};

/// In every file `tmuxy server install` writes: how a file at the same path
/// that the user wrote is told from ours, and left alone.
pub const MARKER: &str =
    "tmuxy-managed: written by `tmuxy server install`, removed by `tmuxy server uninstall`";

pub const SYSTEMD_UNIT: &str = "tmuxy.service";
pub const LAUNCHD_LABEL: &str = "sh.tmuxy.server";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Manager {
    Systemd,
    Launchd,
}

impl Manager {
    pub fn name(self) -> &'static str {
        match self {
            Manager::Systemd => "systemd",
            Manager::Launchd => "launchd",
        }
    }

    /// The service manager of the machine this build runs on.
    pub fn current() -> Result<Self, ServiceError> {
        if cfg!(target_os = "linux") {
            Ok(Manager::Systemd)
        } else if cfg!(target_os = "macos") {
            Ok(Manager::Launchd)
        } else {
            Err(ServiceError::Unsupported)
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum ServiceError {
    Unsupported,
    /// A file at the unit's path that tmuxy did not write.
    Foreign(PathBuf),
    BadHost(String),
    Secret(String),
}

impl std::fmt::Display for ServiceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ServiceError::Unsupported => f.write_str(
                "not supported here yet; run `tmuxy server` under your service manager",
            ),
            ServiceError::Foreign(path) => write!(
                f,
                "{} exists and tmuxy did not write it; left alone. Move it away, or manage it yourself",
                path.display()
            ),
            ServiceError::BadHost(message) | ServiceError::Secret(message) => f.write_str(message),
        }
    }
}

/// How the server is started: the running binary and what it was asked.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Spec {
    pub exe: PathBuf,
    /// The verb that makes the binary a server (`server` for the desktop
    /// binary, none for `tmuxy-server`).
    pub subcommand: Option<String>,
    pub port: u16,
    pub host: String,
    pub allowed_hosts: Vec<String>,
    /// The `PATH` the server runs with, so it finds tmux: a service manager
    /// starts it with a bare one.
    pub path_env: Option<String>,
    pub env_file: PathBuf,
    pub log_file: PathBuf,
}

impl Spec {
    /// The command line that runs the server, binary first.
    pub fn argv(&self) -> Vec<String> {
        let mut argv = vec![self.exe.to_string_lossy().into_owned()];
        argv.extend(self.subcommand.clone());
        argv.extend(["--port".into(), self.port.to_string()]);
        argv.extend(["--host".into(), self.host.clone()]);
        for host in &self.allowed_hosts {
            argv.extend(["--allowed-host".into(), host.clone()]);
        }
        argv
    }
}

/// Who and where the service belongs to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Ctx {
    pub home: PathBuf,
    pub uid: u32,
    pub user: Option<String>,
}

/// What is at the unit's path now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Existing {
    Absent,
    Ours(String),
    Foreign,
}

impl Existing {
    pub fn classify(text: Option<&str>) -> Self {
        match text {
            None => Existing::Absent,
            Some(text) if text.contains("tmuxy-managed:") => Existing::Ours(text.to_string()),
            Some(_) => Existing::Foreign,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Step {
    pub argv: Vec<String>,
    /// A failure is reported and the plan goes on.
    pub optional: bool,
    /// Whether this step turns lingering on.
    pub linger: bool,
}

impl Step {
    fn required(argv: &[&str]) -> Self {
        Self::new(argv, false, false)
    }

    fn optional(argv: &[&str]) -> Self {
        Self::new(argv, true, false)
    }

    fn new(argv: &[&str], optional: bool, linger: bool) -> Self {
        Self {
            argv: argv.iter().map(|a| a.to_string()).collect(),
            optional,
            linger,
        }
    }

    pub fn display(&self) -> String {
        self.argv.join(" ")
    }
}

#[derive(Debug, PartialEq, Eq)]
pub struct InstallPlan {
    pub manager: Manager,
    pub unit_path: PathBuf,
    pub unit_text: String,
    /// Run after the unit is written, in order.
    pub steps: Vec<Step>,
    pub linger: bool,
}

#[derive(Debug, PartialEq, Eq)]
pub struct UninstallPlan {
    pub manager: Manager,
    pub unit_path: PathBuf,
    /// Run before the file goes.
    pub before: Vec<Step>,
    /// Whether there is a file of ours to remove.
    pub remove_file: bool,
    /// Run after the file is gone.
    pub after: Vec<Step>,
}

pub fn unit_path(manager: Manager, home: &Path) -> PathBuf {
    match manager {
        Manager::Systemd => home.join(".config/systemd/user").join(SYSTEMD_UNIT),
        Manager::Launchd => home
            .join("Library/LaunchAgents")
            .join(format!("{LAUNCHD_LABEL}.plist")),
    }
}

fn gui_domain(ctx: &Ctx) -> String {
    format!("gui/{}", ctx.uid)
}

/// A word of a systemd command line: quoted when it holds anything the
/// parser would split or expand.
fn systemd_word(word: &str) -> String {
    let plain = !word.is_empty()
        && word
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "_@+=:,./-".contains(c));
    if plain {
        return word.to_string();
    }
    let escaped = word
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('%', "%%")
        .replace('$', "$$");
    format!("\"{escaped}\"")
}

pub fn systemd_unit(spec: &Spec) -> String {
    let exec = spec
        .argv()
        .iter()
        .map(|w| systemd_word(w))
        .collect::<Vec<_>>()
        .join(" ");
    let mut lines = vec![
        format!("# {MARKER}"),
        "[Unit]".to_string(),
        "Description=tmuxy web server".to_string(),
        "After=network-online.target".to_string(),
        String::new(),
        "[Service]".to_string(),
        format!("ExecStart={exec}"),
        format!("EnvironmentFile=-{}", spec.env_file.display()),
    ];
    if let Some(path) = &spec.path_env {
        lines.push(format!(
            "Environment={}",
            systemd_word(&format!("PATH={path}"))
        ));
    }
    lines.extend([
        "Restart=on-failure".to_string(),
        "RestartSec=3".to_string(),
        String::new(),
        "[Install]".to_string(),
        "WantedBy=default.target".to_string(),
    ]);
    lines.join("\n") + "\n"
}

fn xml_escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// The agent runs the server through `sh`, which reads the environment file
/// first: launchd has no equivalent of `EnvironmentFile`, and the password
/// must not be written into the plist.
pub fn launchd_plist(spec: &Spec) -> String {
    let mut words = vec![
        "/bin/sh".to_string(),
        "-c".to_string(),
        "set -a; [ -r \"$1\" ] && . \"$1\"; shift; exec \"$@\"".to_string(),
        "tmuxy-server".to_string(),
        spec.env_file.to_string_lossy().into_owned(),
    ];
    words.extend(spec.argv());
    let args: String = words
        .iter()
        .map(|w| format!("    <string>{}</string>\n", xml_escape(w)))
        .collect();
    let env = spec
        .path_env
        .as_ref()
        .map(|path| {
            format!(
                "  <key>EnvironmentVariables</key>\n  <dict>\n    <key>PATH</key>\n    <string>{}</string>\n  </dict>\n",
                xml_escape(path)
            )
        })
        .unwrap_or_default();
    let log = xml_escape(&spec.log_file.to_string_lossy());
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
         <!-- {MARKER} -->\n\
         <!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n\
         <plist version=\"1.0\">\n<dict>\n\
         \x20 <key>Label</key>\n  <string>{LAUNCHD_LABEL}</string>\n\
         \x20 <key>ProgramArguments</key>\n  <array>\n{args}  </array>\n\
         {env}\
         \x20 <key>RunAtLoad</key>\n  <true/>\n\
         \x20 <key>KeepAlive</key>\n  <true/>\n\
         \x20 <key>StandardOutPath</key>\n  <string>{log}</string>\n\
         \x20 <key>StandardErrorPath</key>\n  <string>{log}</string>\n\
         </dict>\n</plist>\n"
    )
}

pub fn unit_text(manager: Manager, spec: &Spec) -> String {
    match manager {
        Manager::Systemd => systemd_unit(spec),
        Manager::Launchd => launchd_plist(spec),
    }
}

/// The install, or the reason there is none. A file of the user's at the
/// unit's path is never touched; one of ours is replaced, and a server it
/// started is restarted when the text changed.
pub fn install_plan(
    manager: Manager,
    spec: &Spec,
    ctx: &Ctx,
    no_linger: bool,
    existing: &Existing,
) -> Result<InstallPlan, ServiceError> {
    let path = unit_path(manager, &ctx.home);
    if *existing == Existing::Foreign {
        return Err(ServiceError::Foreign(path));
    }
    let text = unit_text(manager, spec);
    let changed = matches!(existing, Existing::Ours(old) if *old != text);
    let path_str = path.to_string_lossy().into_owned();
    let (steps, linger) = match manager {
        Manager::Systemd => systemd_install_steps(ctx, no_linger, changed),
        Manager::Launchd => {
            let target = format!("{}/{LAUNCHD_LABEL}", gui_domain(ctx));
            let steps = vec![
                Step::optional(&["launchctl", "bootout", &target]),
                Step::required(&["launchctl", "bootstrap", &gui_domain(ctx), &path_str]),
            ];
            (steps, false)
        }
    };
    Ok(InstallPlan {
        manager,
        unit_path: path,
        unit_text: text,
        steps,
        linger,
    })
}

fn systemd_install_steps(ctx: &Ctx, no_linger: bool, changed: bool) -> (Vec<Step>, bool) {
    let mut steps = vec![
        Step::required(&["systemctl", "--user", "daemon-reload"]),
        Step::required(&["systemctl", "--user", "enable", "--now", SYSTEMD_UNIT]),
    ];
    if changed {
        steps.push(Step::required(&[
            "systemctl",
            "--user",
            "restart",
            SYSTEMD_UNIT,
        ]));
    }
    if !no_linger {
        let mut argv = vec!["loginctl", "enable-linger"];
        argv.extend(ctx.user.as_deref());
        steps.push(Step::new(&argv, true, true));
    }
    (steps, !no_linger)
}

/// The uninstall, or the reason there is none. Lingering is left on: other
/// services of the user may need it.
pub fn uninstall_plan(
    manager: Manager,
    ctx: &Ctx,
    existing: &Existing,
) -> Result<UninstallPlan, ServiceError> {
    let path = unit_path(manager, &ctx.home);
    match existing {
        Existing::Foreign => Err(ServiceError::Foreign(path)),
        Existing::Absent => Ok(UninstallPlan {
            manager,
            unit_path: path,
            before: vec![],
            remove_file: false,
            after: vec![],
        }),
        Existing::Ours(_) => {
            let (before, after) = match manager {
                Manager::Systemd => (
                    vec![Step::optional(&[
                        "systemctl",
                        "--user",
                        "disable",
                        "--now",
                        SYSTEMD_UNIT,
                    ])],
                    vec![Step::required(&["systemctl", "--user", "daemon-reload"])],
                ),
                Manager::Launchd => (
                    vec![Step::optional(&[
                        "launchctl",
                        "bootout",
                        &format!("{}/{LAUNCHD_LABEL}", gui_domain(ctx)),
                    ])],
                    vec![],
                ),
            };
            Ok(UninstallPlan {
                manager,
                unit_path: path,
                before,
                remove_file: true,
                after,
            })
        }
    }
}

/// What the environment file holds, as far as an install cares.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EnvFile {
    Missing,
    Present { password_set: bool, mode: u32 },
}

impl EnvFile {
    pub fn parse(text: &str, mode: u32) -> Self {
        let password_set = text.lines().any(|line| {
            line.trim()
                .strip_prefix("TMUXY_PASSWORD=")
                .is_some_and(|v| !v.trim_matches(['"', '\'', ' ']).is_empty())
        });
        EnvFile::Present { password_set, mode }
    }
}

/// A server on a non-loopback host needs a password, and the unit gets it
/// from the environment file, never from its own text. The file must be
/// private to the user.
pub fn check_secret(loopback: bool, env: &EnvFile, env_path: &Path) -> Result<(), ServiceError> {
    if loopback {
        return Ok(());
    }
    let path = env_path.display();
    let how = format!(
        "create it with a line `TMUXY_PASSWORD=<secret>` and `chmod 600 {path}`, then install again"
    );
    match env {
        EnvFile::Missing => Err(ServiceError::Secret(format!(
            "a server on a non-loopback --host needs a password, and {path} does not exist: {how}"
        ))),
        EnvFile::Present { password_set: false, .. } => Err(ServiceError::Secret(format!(
            "{path} has no TMUXY_PASSWORD: {how}"
        ))),
        EnvFile::Present { mode, .. } if mode & 0o077 != 0 => Err(ServiceError::Secret(format!(
            "{path} is readable by others (mode {:03o}): run `chmod 600 {path}`, then install again",
            mode & 0o777
        ))),
        EnvFile::Present { .. } => Ok(()),
    }
}

/// The hint shown when lingering could not be turned on.
pub fn linger_hint(user: Option<&str>) -> String {
    format!(
        "could not turn lingering on: the server runs while you are logged in. An admin can start it at boot with `sudo loginctl enable-linger {}`",
        user.unwrap_or("<user>")
    )
}

#[cfg(test)]
mod tests;
