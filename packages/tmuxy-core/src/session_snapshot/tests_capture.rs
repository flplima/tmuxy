use std::collections::BTreeMap;

use super::*;
use crate::ids::test_ids::{gid, wid};

/// `parse_windows` names the option columns by position, so the query
/// must print them in exactly `WINDOW_OPTION_NAMES` order, after the type
/// and the parent.
#[test]
fn query_windows_prints_the_options_in_name_order() {
    let mut expected = vec![
        format!("#{{{}}}", tmux_options::WINDOW_TYPE),
        format!("#{{{}}}", tmux_options::FLOAT_PARENT),
    ];
    expected.extend(WINDOW_OPTION_NAMES.iter().map(|n| format!("#{{{n}}}")));
    let fields: Vec<&str> = QUERY_WINDOWS
        .split(['\'', ','])
        .filter(|f| f.starts_with("#{@"))
        .collect();
    assert_eq!(fields, expected);
}

pub(super) fn window_line(
    id: &str,
    index: u32,
    active: bool,
    kind: &str,
    parent: &str,
    layout: &str,
    name: &str,
) -> String {
    // id, index, active, type, parent, nine empty options, layout, name
    format!(
        "{id},{index},{},{kind},{parent},,,,,,,,,,{layout},{name}",
        u8::from(active)
    )
}

#[test]
fn a_window_record_round_trips_its_tags_and_a_comma_in_its_name() {
    let out = [
        window_line("@1", 0, true, "", "", "a1b2%2C80x24%2C0%2C0%2C5", "main"),
        // A float, with a parent and a width; the name has a comma.
        "@3,2,0,float,@1,120,40,,dim,1,,,,,b7c1%2C120x40%2C0%2C0%2C9,notes%2C today".to_string(),
    ]
    .join("\n");
    let windows = parse_windows(&out);
    assert_eq!(windows.len(), 2);
    assert_eq!(windows[0].layout, "a1b2,80x24,0,0,5");
    assert_eq!(windows[0].name, "main");
    assert!(windows[0].active);
    assert_eq!(windows[1].window_type.as_deref(), Some("float"));
    assert_eq!(windows[1].float_parent_id, Some(wid("@1")));
    assert_eq!(windows[1].options["@tmuxy-float-width"], "120");
    assert_eq!(windows[1].options["@tmuxy-float-bg"], "dim");
    assert_eq!(windows[1].options["@tmuxy-float-noheader"], "1");
    assert!(!windows[1].options.contains_key("@tmuxy-float-drawer"));
    assert_eq!(windows[1].name, "notes, today");
}

#[test]
fn a_pane_record_keeps_a_comma_in_its_path_and_its_restore_command() {
    let out = "%5,@1,0,1,4242,/dev/ttys003,/Users/x/a%2Cb,claude --resume abc%2Cdef,g2,,\n\
               garbage line\n\
               %6,@1,1,0,4300,/dev/ttys004,/tmp,,,,";
    let panes = parse_panes(out);
    assert_eq!(panes.len(), 2);
    assert_eq!(panes[0].cwd, "/Users/x/a,b");
    assert_eq!(
        panes[0].restore_command.as_deref(),
        Some("claude --resume abc,def")
    );
    assert_eq!(panes[0].group_id, Some(gid("g2")));
    assert_eq!(panes[0].pid, 4242);
    assert!(panes[1].restore_command.is_none());
    assert!(panes[1].group_id.is_none());
}

#[test]
fn the_queries_name_the_session_and_escape_what_can_hold_a_comma() {
    let (w, p) = queries_for("work");
    assert!(w.starts_with("list-windows -t work "));
    assert!(w.contains("#{s/,/%2C/:window_layout}"));
    assert!(w.contains("#{s/,/%2C/:window_name}"));
    assert!(p.contains("#{s/,/%2C/:pane_current_path}"));
    assert!(p.contains("#{s/,/%2C/:@tmuxy-pane-restore}"));
    // The argv form keeps the format as one word.
    let argv = split_query(&p);
    assert_eq!(argv[0], "list-panes");
    assert_eq!(argv[argv.len() - 2], "-F");
    assert!(argv[argv.len() - 1].starts_with("#{pane_id},"));
    assert!(!argv[argv.len() - 1].ends_with('\''));
}

/// The foreground job is the group `tpgid` names; the shell is not it.
#[test]
fn the_foreground_program_is_the_leader_of_the_terminals_foreground_group() {
    let ps = "\
  4242  4242  5100 01:02:03 -zsh\n\
  5100  5100  5100    12:30 vim notes.md\n\
  5101  5100  5100    00:02 /bin/sh -c spell\n";
    assert_eq!(
        foreground(ps, 4242).map(|f| f.argv),
        Some(vec!["vim".to_string(), "notes.md".to_string()])
    );
}

#[test]
fn an_idle_shell_has_nothing_to_offer() {
    // The shell is the foreground group itself.
    let ps = "  4242  4242  4242 01:02:03 -zsh\n";
    assert!(foreground(ps, 4242).is_none());
    // A background job does not count: its group is not the foreground one.
    let ps = "  4242  4242  4242 01:02:03 -zsh\n  5000  5000  4242 00:10 sleep 100\n";
    assert!(foreground(ps, 4242).is_none());
    // A process on its way out is nobody's program.
    let ps = "  4242  4242  5300 01:02:03 -zsh\n  5300  5300  5300 00:00 (id)\n";
    assert!(foreground(ps, 4242).is_none());
}

/// `sudo vim` makes sudo the leader; the user typed sudo, so that is right.
#[test]
fn a_wrapper_is_recorded_as_typed() {
    let ps = "  4242  4242  5200 01:02:03 -zsh\n  5200  5200  5200 05:00 sudo vim /etc/hosts\n  5201  5200  5200 05:00 vim /etc/hosts\n";
    assert_eq!(foreground(ps, 4242).unwrap().argv[0], "sudo");
}

/// A prompt's helper holds the terminal for milliseconds; the program the
/// user started a moment ago looks the same until it has aged.
#[test]
fn a_foreground_younger_than_a_prompt_helper_is_not_settled() {
    let ps = "  4242  4242  5400 01:02:03 -zsh\n  5400  5400  5400 00:00 id -Gn\n";
    let young = foreground(ps, 4242).unwrap();
    assert_eq!(young.argv, vec!["id".to_string(), "-Gn".to_string()]);
    assert!(!young.settled());
    let ps = "  4242  4242  5400 01:02:03 -zsh\n  5400  5400  5400 00:02 claude\n";
    assert!(foreground(ps, 4242).unwrap().settled());
    assert_eq!(etime_secs("2-01:00:05"), Some(86_400 * 2 + 3_605));
    assert_eq!(etime_secs("00:02"), Some(2));
    assert_eq!(etime_secs("x"), None);
}

#[test]
fn shells_are_known_by_basename_with_or_without_the_login_dash() {
    let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
    assert!(is_shell(&s(&["-zsh"])));
    assert!(is_shell(&s(&["/bin/bash", "-l"])));
    assert!(is_shell(&s(&["fish"])));
    assert!(!is_shell(&s(&["vim"])));
    assert!(!is_shell(&s(&["/usr/bin/nvim", "-S"])));
    assert!(is_shell(&[]), "nothing readable is treated as the shell");
}

#[test]
fn a_command_is_offered_as_a_shell_line_that_round_trips() {
    let argv = vec![
        "claude".to_string(),
        "--resume".to_string(),
        "it's me".to_string(),
    ];
    assert_eq!(shell_join(&argv), r"claude --resume 'it'\''s me'");
    let pane = PaneSnapshot {
        index: 0,
        active: true,
        cwd: "/".into(),
        command: Some(argv),
        restore_command: Some("claude --resume abc".into()),
        options: BTreeMap::new(),
        scrollback: None,
        offer: None,
    };
    assert_eq!(
        pane.offered_command().as_deref(),
        Some("claude --resume abc"),
        "the program's own word wins"
    );
}

#[test]
fn the_stamp_is_a_sortable_utc_date() {
    assert_eq!(stamp(0), "19700101T000000Z");
    assert_eq!(stamp(1_759_622_400), "20251005T000000Z");
    assert!(stamp(1_759_622_400) < stamp(1_759_622_401));
}

pub(super) fn fixture() -> Snapshot {
    let mut float_opts = BTreeMap::new();
    float_opts.insert("@tmuxy-float-width".to_string(), "100".to_string());
    let mut group = BTreeMap::new();
    group.insert("@tmuxy-group-id".to_string(), "g1".to_string());
    Snapshot {
        version: SNAPSHOT_VERSION,
        session: "work".into(),
        saved_at: 1_759_622_400,
        windows: vec![
            WindowSnapshot {
                index: 0,
                name: "main".into(),
                active: false,
                layout: "b1c2,80x24,0,0{40x24,0,0,1,39x24,41,0,2}".into(),
                window_type: None,
                float_parent_index: None,
                options: BTreeMap::new(),
                panes: vec![
                    PaneSnapshot {
                        index: 0,
                        active: false,
                        cwd: "/tmp".into(),
                        command: None,
                        restore_command: None,
                        options: group.clone(),
                        scrollback: None,
                        offer: None,
                    },
                    PaneSnapshot {
                        index: 1,
                        active: true,
                        cwd: "/does/not/exist".into(),
                        command: Some(vec!["vim".into(), "a".into()]),
                        restore_command: None,
                        options: BTreeMap::new(),
                        scrollback: None,
                        offer: None,
                    },
                ],
            },
            WindowSnapshot {
                index: 2,
                name: "notes".into(),
                active: true,
                layout: "a1b2,100x30,0,0,5".into(),
                window_type: Some("float".into()),
                float_parent_index: Some(0),
                options: float_opts,
                panes: vec![PaneSnapshot {
                    index: 0,
                    active: true,
                    cwd: "/tmp".into(),
                    command: None,
                    restore_command: Some("lazygit".into()),
                    options: BTreeMap::new(),
                    scrollback: None,
                    offer: None,
                }],
            },
        ],
        hidden: vec![HiddenMember {
            group_id: gid("g1"),
            position: None,
            cwd: "/srv".into(),
            command: Some(vec!["htop".into()]),
            restore_command: None,
            offer: None,
        }],
    }
}

pub(super) fn joined(steps: &[Step]) -> Vec<String> {
    steps
        .iter()
        .map(|s| match s {
            Step::Run(a) => format!("run: {}", a.join(" ")),
            Step::Ask { argv: a, .. } => format!("ask: {}", a.join(" ")),
        })
        .collect()
}
