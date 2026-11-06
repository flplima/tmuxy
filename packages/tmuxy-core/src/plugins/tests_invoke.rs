use std::path::Path;

use super::invoke::{self, Target, Token, Trigger};
use super::lockfile::{Entry, Lockfile};
use super::manifest::{self, Dim, Size, Surface};
use super::registry::{resolve_command, Registry};
use super::source;
use super::tests::{dirs_in, plugin_dir, scratch, GOOD};
use super::*;

// ── Invocation ──────────────────────────────────────────────────────────

fn target() -> Target {
    Target {
        pane: "%3".into(),
        window: "@2".into(),
        session_id: "$1".into(),
        window_width: 200,
        window_height: 50,
        free_index: 7,
    }
}

fn joined(argv: &[String]) -> String {
    argv.join(" ")
}

#[test]
fn each_surface_is_one_command_list() {
    let root = Path::new("/plug");
    let split = surface_for(Surface::Split, None);
    assert_eq!(
        joined(&split),
        "split-window -h -t %3 -c /plug -P -F #{pane_id} RUN"
    );
    assert!(joined(&surface_for(Surface::Zoomed, None)).ends_with("RUN ; resize-pane -Z"));
    assert!(joined(&surface_for(Surface::Tab, None)).ends_with("RUN ; break-pane -n name"));

    let float = joined(&surface_for(Surface::Float, None));
    assert!(float.contains("break-pane -d -n float -t $1:7"), "{float}");
    assert!(float.contains("@tmuxy-float-parent @2"), "{float}");
    // The default: 80% x 70% of a 200x50 tab.
    assert!(float.contains("@tmuxy-float-width 160"), "{float}");
    assert!(float.contains("@tmuxy-float-height 35"), "{float}");
    assert!(!float.contains("noheader"), "{float}");
    assert!(float.contains("; select-pane -t %3 ;"), "{float}");

    let sized = Size {
        width: Some(Dim::Cells(300)),
        height: Some(Dim::Percent(50)),
    };
    let popup = joined(&invoke::surface_argv(
        Surface::Popup,
        Some(sized),
        &target(),
        root,
        "RUN",
        "name",
    ));
    assert!(popup.contains("@tmuxy-float-noheader 1"), "{popup}");
    assert!(popup.contains("@tmuxy-float-bg dim"), "{popup}");
    assert!(
        popup.contains("@tmuxy-float-width 200"),
        "never wider than the tab: {popup}"
    );
    assert!(popup.contains("@tmuxy-float-height 25"), "{popup}");
}

fn surface_for(surface: Surface, size: Option<Size>) -> Vec<String> {
    invoke::surface_argv(surface, size, &target(), Path::new("/plug"), "RUN", "name")
}

#[test]
fn the_exec_line_carries_names_and_a_token_only() {
    let line = invoke::exec_command_line(
        Path::new("/opt/tmuxy app/tmuxy"),
        Some("server"),
        "p",
        "a",
        "0123456789abcdef0123456789abcdef",
    )
    .unwrap();
    assert_eq!(
        line,
        "exec '/opt/tmuxy app/tmuxy' server plugin exec p a 0123456789abcdef0123456789abcdef"
    );
    assert!(invoke::exec_command_line(Path::new("/a#b"), None, "p", "a", "t").is_err());
}

#[test]
fn a_token_is_owner_only_and_used_once() {
    let base = scratch("token");
    let dirs = dirs_in(&base);
    let mut token = Token::new("p", "a", Trigger::Menu, "%1");
    token.selection = Some("it's #{x}; $(touch /tmp/pwn)\nline".into());
    let id = token.create(&dirs).unwrap();
    assert_eq!(id.len(), 32);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let file = dirs.run_dir().join(format!("{id}.json"));
        assert_eq!(
            std::fs::metadata(file).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let dir = std::fs::metadata(dirs.run_dir())
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(dir & 0o777, 0o700);
    }
    assert_eq!(Token::take(&dirs, &id).unwrap(), token);
    assert_eq!(Token::take(&dirs, &id).unwrap_err().exit_code(), 3);
    assert!(Token::read(&dirs, "../../etc/passwd").is_err());
    std::fs::remove_dir_all(base).unwrap();
}

#[test]
fn prepare_checks_the_action_and_the_pane() {
    let base = scratch("prepare");
    let dirs = dirs_in(&base);
    let dir = plugin_dir(&base, GOOD, &[]);
    let mut lock = Lockfile::default();
    lock.upsert(Entry::from_path("claude-artifacts", &dir));
    lock.save(&dirs).unwrap();

    let id = invoke::prepare(&dirs, "claude-artifacts", "plain", "%4", Some("sel".into())).unwrap();
    let token = Token::read(&dirs, &id).unwrap();
    assert_eq!(token.trigger, Trigger::Menu);
    assert_eq!(token.selection.as_deref(), Some("sel"));
    assert!(invoke::prepare(&dirs, "claude-artifacts", "nope", "%4", None).is_err());
    assert!(invoke::prepare(&dirs, "claude-artifacts", "plain", "4; rm", None).is_err());
    let huge = "x".repeat(invoke::MAX_SELECTION_BYTES + 1);
    assert!(invoke::prepare(&dirs, "claude-artifacts", "plain", "%4", Some(huge)).is_err());
    std::fs::remove_dir_all(base).unwrap();
}

#[test]
fn the_context_names_the_pane_and_the_selection_file() {
    let base = scratch("context");
    let dirs = dirs_in(&base);
    let dir = plugin_dir(&base, GOOD, &[]);
    let mut lock = Lockfile::default();
    lock.upsert(Entry::from_path("claude-artifacts", &dir));
    lock.save(&dirs).unwrap();
    let registry = Registry::load(&dirs).unwrap();
    let plugin = registry.get("claude-artifacts").unwrap();
    let info = invoke::PaneInfo {
        cwd: "/w".into(),
        command: "zsh".into(),
        tab: "@1".into(),
        session: "main".into(),
    };
    let json: serde_json::Value = serde_json::from_str(
        &invoke::context_json(
            &dirs,
            plugin,
            invoke::Context {
                action: Some("plain"),
                trigger: Trigger::Menu,
                pane: "%9",
                info: Some(&info),
                selection_file: Some(Path::new("/s/file")),
                link: None,
            },
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(json["pane"]["id"], "%9");
    assert_eq!(json["pane"]["cwd"], "/w");
    assert_eq!(json["trigger"], "menu");
    assert_eq!(json["action"], "plain");
    assert_eq!(json["selection_file"], "/s/file");
    assert_eq!(json["settings"], serde_json::json!({}));
    std::fs::remove_dir_all(base).unwrap();
}

// ── Scaffold & GC ───────────────────────────────────────────────────────

#[test]
fn a_new_plugin_passes_its_own_check() {
    let base = scratch("new");
    let dir = scaffold::create(&base, "hello-world").unwrap();
    assert!(dir.ends_with("tmuxy-hello-world"));
    let m = manifest::Manifest::load(&dir).unwrap();
    assert_eq!(m.name, "hello-world");
    resolve_command(&dir, &m.actions[0].command).unwrap();
    assert!(
        scaffold::create(&base, "hello-world").is_err(),
        "never over an existing dir"
    );
    assert!(scaffold::create(&base, "Bad").is_err());
    std::fs::remove_dir_all(base).unwrap();
}

#[test]
fn gc_removes_only_unlisted_unused_checkouts() {
    let base = scratch("gc");
    let dirs = dirs_in(&base);
    let keep = "1111111111111111111111111111111111111111";
    let drop = "2222222222222222222222222222222222222222";
    let busy = "3333333333333333333333333333333333333333";
    let mut lock = Lockfile::default();
    lock.upsert(Entry::from_repo(
        "p",
        &source::parse_repo("o/r").unwrap(),
        keep,
    ));
    lock.save(&dirs).unwrap();
    for sha in [keep, drop, busy] {
        std::fs::create_dir_all(dirs.checkout("p", sha)).unwrap();
    }
    std::fs::create_dir_all(dirs.plugins_root().join("p.state")).unwrap();

    // A process running from the old checkout keeps it.
    let busy_dir = dirs.checkout("p", busy);
    let mut child = std::process::Command::new("sleep")
        .arg("30")
        .current_dir(&busy_dir)
        .spawn()
        .unwrap();
    let collected = gc::collect(&dirs);
    let _ = child.kill();
    let _ = child.wait();

    assert_eq!(collected.removed, vec![dirs.checkout("p", drop)]);
    if Path::new("/proc/self").exists() {
        assert_eq!(collected.busy, vec![busy_dir.clone()]);
        assert!(busy_dir.exists());
    }
    assert!(dirs.checkout("p", keep).exists());
    assert!(
        dirs.plugins_root().join("p.state").exists(),
        "not a checkout"
    );
    // Once its process is gone, the next run removes it.
    assert!(gc::collect(&dirs).busy.is_empty());
    assert!(!busy_dir.exists());
    std::fs::remove_dir_all(base).unwrap();
}
