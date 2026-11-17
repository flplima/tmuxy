//! `tmuxy server install | uninstall`, and the service line of `status`: the
//! part that reads the machine and runs what `service` planned.

use clap::Args;
use std::path::{Path, PathBuf};
use tmuxy_core::cli_contract::{json_failure, json_ok, json_string, EXIT_FAILED, EXIT_USAGE};

use crate::request_guard::HostPolicy;
use crate::service::{
    self, Ctx, EnvFile, Existing, InstallPlan, Manager, ServiceError, Spec, Step, UninstallPlan,
};

#[derive(Args)]
pub struct InstallArgs {
    /// Port the service listens on
    #[arg(long, default_value_t = tmuxy_core::constants::DEFAULT_SERVER_PORT)]
    pub port: u16,

    /// Address the service listens on. The default is this machine only. Any
    /// other address needs a password: create `server.env` in tmuxy's config
    /// dir (`tmuxy config paths`) with a line `TMUXY_PASSWORD=<secret>` and
    /// mode 0600, which the service reads; the secret is never written into
    /// the unit.
    #[arg(long, default_value = "127.0.0.1")]
    pub host: String,

    /// A hostname requests may be addressed to besides loopback ones (a
    /// reverse proxy's public name). Repeatable.
    #[arg(long = "allowed-host", value_name = "HOST")]
    pub allowed_hosts: Vec<String>,

    /// Do not turn on lingering: the service then runs while you are logged
    /// in, not from boot (Linux)
    #[arg(long)]
    pub no_linger: bool,

    /// Print every file and command and change nothing
    #[arg(long)]
    pub dry_run: bool,

    /// Print the result as JSON
    #[arg(long)]
    pub json: bool,
}

#[derive(Args)]
pub struct UninstallArgs {
    /// Print every file and command and change nothing
    #[arg(long)]
    pub dry_run: bool,

    /// Print the result as JSON
    #[arg(long)]
    pub json: bool,
}

#[derive(Args)]
pub struct StatusArgs {
    /// Print the status as JSON
    #[arg(long)]
    pub json: bool,
}

/// What the user sees: narration on stdout, or on stderr under `--json` so
/// stdout holds the one object.
struct Out {
    json: bool,
}

impl Out {
    fn say(&self, line: &str) {
        if self.json {
            eprintln!("{line}");
        } else {
            println!("{line}");
        }
    }

    fn fail(&self, code: i32, message: &str) -> ! {
        if self.json {
            println!("{}", json_failure(code, message, &[]));
        } else {
            eprintln!("tmuxy server: {message}");
        }
        std::process::exit(code)
    }

    fn done(&self, fields: &[(&str, String)]) {
        if self.json {
            println!("{}", json_ok(fields));
        }
    }
}

fn context() -> Ctx {
    Ctx {
        home: tmuxy_core::paths::Layout::current().home,
        uid: current_uid(),
        user: std::env::var("USER")
            .or_else(|_| std::env::var("LOGNAME"))
            .ok()
            .filter(|u| !u.is_empty()),
    }
}

#[cfg(unix)]
fn current_uid() -> u32 {
    // SAFETY: getuid has no preconditions and cannot fail.
    unsafe { libc::getuid() }
}

#[cfg(not(unix))]
fn current_uid() -> u32 {
    0
}

fn read_existing(path: &Path) -> Existing {
    Existing::classify(std::fs::read_to_string(path).ok().as_deref())
}

fn read_env_file(path: &Path) -> EnvFile {
    let Ok(text) = std::fs::read_to_string(path) else {
        return EnvFile::Missing;
    };
    EnvFile::parse(&text, file_mode(path))
}

#[cfg(unix)]
fn file_mode(path: &Path) -> u32 {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path).map_or(0o600, |m| m.permissions().mode())
}

#[cfg(not(unix))]
fn file_mode(_path: &Path) -> u32 {
    0o600
}

fn is_loopback(host: &str) -> Result<bool, ServiceError> {
    crate::server::resolve_listen(host, true, false, vec![])
        .map(|listen| matches!(listen.policy, HostPolicy::Loopback { .. }))
        .map_err(ServiceError::BadHost)
}

fn spec_for(args: &InstallArgs) -> Result<Spec, String> {
    let (exe, subcommand) = tmuxy_core::session::server_command()
        .or_else(|| tmuxy_core::session::invoked_exe().map(|exe| (exe, None)))
        .ok_or("cannot tell which binary is running")?;
    let layout = tmuxy_core::paths::Layout::current();
    Ok(Spec {
        exe,
        subcommand: subcommand.map(String::from),
        port: args.port,
        host: args.host.clone(),
        allowed_hosts: args.allowed_hosts.clone(),
        path_env: std::env::var("PATH").ok().filter(|p| !p.is_empty()),
        env_file: layout.path(&tmuxy_core::paths::SERVER_ENV),
        log_file: layout.path(&tmuxy_core::paths::SERVER_LOG),
    })
}

fn print_file(out: &Out, path: &Path, text: &str) {
    out.say(&format!("write {}", path.display()));
    for line in text.lines() {
        out.say(&format!("  | {line}"));
    }
}

fn print_steps(out: &Out, steps: &[Step]) {
    for step in steps {
        out.say(&format!("run   {}", step.display()));
    }
}

/// Run one step. `Ok(false)` is an optional step that failed.
fn run_step(out: &Out, step: &Step) -> Result<bool, String> {
    let (program, rest) = step.argv.split_first().ok_or("an empty command")?;
    let status = std::process::Command::new(program).args(rest).status();
    match status {
        Ok(status) if status.success() => Ok(true),
        _ if step.optional => Ok(false),
        Ok(status) => Err(format!("`{}` failed ({status})", step.display())),
        Err(e) => {
            out.say(&format!("`{program}` could not run: {e}"));
            Err(format!("`{}` could not run: {e}", step.display()))
        }
    }
}

/// Run `steps`, stopping at a required one that fails. Returns whether the
/// step that turns lingering on worked, if there was one.
fn run_steps(out: &Out, steps: &[Step]) -> Option<bool> {
    let mut linger = None;
    for step in steps {
        match run_step(out, step) {
            Ok(worked) => {
                if step.linger {
                    linger = Some(worked);
                }
            }
            Err(message) => out.fail(EXIT_FAILED, &message),
        }
    }
    linger
}

pub fn install(args: InstallArgs) {
    let out = Out { json: args.json };
    let plan = plan_install(&out, &args);
    out.say(&format!("tmuxy server install ({})", plan.manager.name()));
    print_file(&out, &plan.unit_path, &plan.unit_text);
    print_steps(&out, &plan.steps);
    if args.dry_run {
        out.say("dry run: nothing was changed");
        return out.done(&install_fields(&plan, plan.linger, true));
    }
    if let Err(e) = write_unit(&plan) {
        out.fail(
            EXIT_FAILED,
            &format!("cannot write {}: {e}", plan.unit_path.display()),
        );
    }
    let linger_worked = run_steps(&out, &plan.steps);
    let linger = plan.linger && linger_worked != Some(false);
    if plan.linger && !linger {
        out.say(&service::linger_hint(context().user.as_deref()));
    }
    out.say(&format!(
        "installed: the web server runs on port {}",
        args.port
    ));
    out.done(&install_fields(&plan, linger, false));
}

fn install_fields(plan: &InstallPlan, linger: bool, dry_run: bool) -> Vec<(&'static str, String)> {
    let mut fields = vec![
        ("unit", json_string(&plan.unit_path.to_string_lossy())),
        ("manager", json_string(plan.manager.name())),
        ("linger", linger.to_string()),
    ];
    if dry_run {
        fields.push(("dryRun", "true".into()));
    }
    fields
}

fn plan_install(out: &Out, args: &InstallArgs) -> InstallPlan {
    let manager = Manager::current().unwrap_or_else(|e| out.fail(EXIT_FAILED, &e.to_string()));
    let spec = spec_for(args).unwrap_or_else(|e| out.fail(EXIT_FAILED, &e));
    let ctx = context();
    let checked = is_loopback(&args.host)
        .and_then(|loopback| {
            service::check_secret(loopback, &read_env_file(&spec.env_file), &spec.env_file)
        })
        .map_err(|e| (EXIT_USAGE, e));
    if let Err((code, e)) = checked {
        out.fail(code, &e.to_string());
    }
    let existing = read_existing(&service::unit_path(manager, &ctx.home));
    service::install_plan(manager, &spec, &ctx, args.no_linger, &existing)
        .unwrap_or_else(|e| out.fail(EXIT_FAILED, &e.to_string()))
}

fn write_unit(plan: &InstallPlan) -> std::io::Result<()> {
    if let Some(dir) = plan.unit_path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    if plan.manager == Manager::Launchd {
        std::fs::create_dir_all(tmuxy_core::paths::Layout::current().state)?;
    }
    std::fs::write(&plan.unit_path, &plan.unit_text)
}

pub fn uninstall(args: UninstallArgs) {
    let out = Out { json: args.json };
    let manager = Manager::current().unwrap_or_else(|e| out.fail(EXIT_FAILED, &e.to_string()));
    let ctx = context();
    let existing = read_existing(&service::unit_path(manager, &ctx.home));
    let plan = service::uninstall_plan(manager, &ctx, &existing)
        .unwrap_or_else(|e| out.fail(EXIT_FAILED, &e.to_string()));
    out.say(&format!("tmuxy server uninstall ({})", manager.name()));
    describe_removal(&out, &plan);
    if !args.dry_run {
        run_steps(&out, &plan.before);
        if plan.remove_file {
            if let Err(e) = std::fs::remove_file(&plan.unit_path) {
                out.fail(
                    EXIT_FAILED,
                    &format!("cannot remove {}: {e}", plan.unit_path.display()),
                );
            }
        }
        run_steps(&out, &plan.after);
    }
    out.say(&uninstall_note(&plan, args.dry_run));
    out.done(&[
        ("unit", json_string(&plan.unit_path.to_string_lossy())),
        ("manager", json_string(manager.name())),
        ("removed", (plan.remove_file && !args.dry_run).to_string()),
    ]);
}

fn describe_removal(out: &Out, plan: &UninstallPlan) {
    print_steps(out, &plan.before);
    if plan.remove_file {
        out.say(&format!("remove {}", plan.unit_path.display()));
    }
    print_steps(out, &plan.after);
}

fn uninstall_note(plan: &UninstallPlan, dry_run: bool) -> String {
    let linger = if plan.manager == Manager::Systemd {
        "; lingering stays on (other services may need it: `loginctl disable-linger` turns it off)"
    } else {
        ""
    };
    match (plan.remove_file, dry_run) {
        (false, _) => format!("not installed: nothing at {}", plan.unit_path.display()),
        (true, true) => format!("dry run: nothing was changed{linger}"),
        (true, false) => format!("uninstalled{linger}"),
    }
}

/// Whether the service is installed (a file of ours) and running, for `status`.
pub struct ServiceStatus {
    pub manager: Manager,
    pub unit: PathBuf,
    pub installed: bool,
    pub active: bool,
}

pub fn service_status() -> Option<ServiceStatus> {
    let manager = Manager::current().ok()?;
    let ctx = context();
    let unit = service::unit_path(manager, &ctx.home);
    let installed = matches!(read_existing(&unit), Existing::Ours(_));
    let active = installed && is_active(manager, &ctx);
    Some(ServiceStatus {
        manager,
        unit,
        installed,
        active,
    })
}

fn is_active(manager: Manager, ctx: &Ctx) -> bool {
    let (program, args) = match manager {
        Manager::Systemd => (
            "systemctl",
            vec![
                "--user".into(),
                "is-active".into(),
                "--quiet".into(),
                service::SYSTEMD_UNIT.to_string(),
            ],
        ),
        Manager::Launchd => (
            "launchctl",
            vec![
                "print".into(),
                format!("gui/{}/{}", ctx.uid, service::LAUNCHD_LABEL),
            ],
        ),
    };
    std::process::Command::new(program)
        .args(args)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
}

impl ServiceStatus {
    pub fn line(&self) -> String {
        let state = match (self.installed, self.active) {
            (false, _) => {
                "not installed (`tmuxy server install` keeps it running at login)".to_string()
            }
            (true, true) => format!(
                "installed and active ({}, {})",
                self.manager.name(),
                self.unit.display()
            ),
            (true, false) => format!(
                "installed, not active ({}, {})",
                self.manager.name(),
                self.unit.display()
            ),
        };
        format!("Service: {state}")
    }

    pub fn json(&self) -> String {
        format!(
            "{{\"manager\":{},\"unit\":{},\"installed\":{},\"active\":{}}}",
            json_string(self.manager.name()),
            json_string(&self.unit.to_string_lossy()),
            self.installed,
            self.active
        )
    }
}

/// What `tmuxy server status --json` prints.
pub fn status_json(pid: Option<u32>, service: Option<&ServiceStatus>) -> String {
    let pid_json = pid.map_or_else(|| "null".to_string(), |p| p.to_string());
    let service = service.map_or_else(|| "null".to_string(), ServiceStatus::json);
    format!(
        "{{\"ok\":true,\"running\":{},\"pid\":{pid_json},\"service\":{service}}}",
        pid.is_some()
    )
}
