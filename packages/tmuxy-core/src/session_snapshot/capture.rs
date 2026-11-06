use std::collections::{BTreeMap, HashMap};

use super::*;

/// The separator of a record's fields. Free text goes through `s/,/%2C/`
/// ([`escaped`]); every other field is comma-free (ids, flags, numbers,
/// base64).
const FIELD_SEP: char = ',';

fn unescape(field: &str) -> String {
    field.replace("%2C", ",")
}

fn escaped(column: &str) -> String {
    format!("s/,/%2C/:{column}")
}

fn window_columns() -> Vec<String> {
    let mut columns: Vec<String> = [
        "window_id",
        "window_index",
        "window_active",
        tmux_options::WINDOW_TYPE,
        tmux_options::FLOAT_PARENT,
    ]
    .map(str::to_string)
    .into();
    columns.extend(WINDOW_OPTION_NAMES.map(str::to_string));
    columns.extend([escaped("window_layout"), escaped("window_name")]);
    columns
}

fn pane_columns() -> Vec<String> {
    vec![
        "pane_id".into(),
        "window_id".into(),
        "pane_index".into(),
        "pane_active".into(),
        "pane_pid".into(),
        escaped("pane_tty"),
        escaped("pane_current_path"),
        escaped(tmux_options::PANE_RESTORE),
        escaped(tmux_options::GROUP_ID),
        tmux_options::GROUP_POS.into(),
        // Base64, so it holds no comma.
        tmux_options::ASK.into(),
    ]
}

fn format_of(columns: &[String]) -> String {
    columns
        .iter()
        .map(|c| format!("#{{{c}}}"))
        .collect::<Vec<_>>()
        .join(&FIELD_SEP.to_string())
}

/// A record's fields by column, or `None` for a line that is not one record
/// of exactly these columns.
fn record<'a>(columns: &'a [String], line: &'a str) -> Option<HashMap<&'a str, &'a str>> {
    let fields: Vec<&str> = line.split(FIELD_SEP).collect();
    (fields.len() == columns.len())
        .then(|| columns.iter().map(String::as_str).zip(fields).collect())
}

fn list_query(verb: &str, target_flag: &str, target: &str, columns: &[String]) -> Vec<String> {
    [verb, target_flag, "-t", target, "-F", &format_of(columns)]
        .into_iter()
        .filter(|w| !w.is_empty())
        .map(str::to_string)
        .collect()
}

/// The windows of `session`, as argv ([`parse_windows`] reads the output).
pub fn query_windows(session: &str) -> Vec<String> {
    list_query("list-windows", "", session, &window_columns())
}

/// Every pane of `session` ([`parse_panes`] reads the output).
pub fn query_panes(session: &str) -> Vec<String> {
    list_query("list-panes", "-s", session, &pane_columns())
}

/// The stash session's panes, in the same record shape as [`query_panes`].
pub fn query_stash_panes() -> Vec<String> {
    query_panes(crate::constants::STASH_SESSION)
}

/// A layout as `select-layout` on any supported tmux takes it: tmux 3.8's
/// JSON becomes the classic string, which only 3.8 itself would not need;
/// anything else — the classic string, or something unrecognised — is kept
/// exactly as tmux printed it, for tmux to judge.
pub(super) fn restorable_layout(layout: &str) -> String {
    crate::layout::parse_json(layout)
        .map(|node| crate::layout::serialize(&node))
        .unwrap_or_else(|| layout.to_string())
}

/// The hidden members of `snapshot`'s groups among the stash's `stash` panes.
/// A stash pane with no group tag, or whose group has no visible pane in this
/// session, belongs to some other session (or to nobody) and is left out.
pub fn hidden_members(
    snapshot: &Snapshot,
    stash: &[PaneRecord],
    commands: &HashMap<PaneId, Vec<String>>,
) -> Vec<HiddenMember> {
    let visible_groups: std::collections::BTreeSet<&str> = snapshot
        .windows
        .iter()
        .flat_map(|w| &w.panes)
        .filter_map(|p| p.options.get(tmux_options::GROUP_ID).map(String::as_str))
        .collect();
    let mut parked: Vec<(&PaneRecord, &GroupId)> = stash
        .iter()
        .filter_map(|p| Some((p, p.group_id.as_ref()?)))
        .filter(|(_, g)| visible_groups.contains(g.as_str()))
        .collect();
    parked.sort_by_key(|(p, _)| crate::groups::order_key(p.group_pos, &p.id));
    parked
        .into_iter()
        .map(|(p, group_id)| {
            let command = commands.get(&p.id).cloned();
            HiddenMember {
                group_id: group_id.clone(),
                position: p.group_pos,
                cwd: p.cwd.clone(),
                offer: p
                    .offer
                    .clone()
                    .filter(|_| command.is_none() && p.restore_command.is_none()),
                command,
                restore_command: p.restore_command.clone(),
            }
        })
        .collect()
}

/// A window as [`query_windows`] prints it, before it is tied to its panes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WindowRecord {
    pub id: WindowId,
    pub index: u32,
    pub active: bool,
    pub window_type: Option<String>,
    pub float_parent_id: Option<WindowId>,
    pub options: BTreeMap<String, String>,
    pub layout: String,
    pub name: String,
}

/// A pane as [`query_panes`] prints it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PaneRecord {
    pub id: PaneId,
    pub window_id: WindowId,
    pub index: u32,
    pub active: bool,
    pub pid: u32,
    pub tty: String,
    pub cwd: String,
    pub restore_command: Option<String>,
    pub group_id: Option<GroupId>,
    pub group_pos: Option<u32>,
    /// The command an unanswered restore offer holds (see [`offer_payload`]).
    pub offer: Option<String>,
}

fn opt(field: &str) -> Option<String> {
    let value = unescape(field.trim());
    (!value.is_empty()).then_some(value)
}

/// The window options restored verbatim, in the order [`query_windows`]
/// prints them after the type and parent.
pub(super) const WINDOW_OPTION_NAMES: [&str; 9] = [
    tmux_options::FLOAT_WIDTH,
    tmux_options::FLOAT_HEIGHT,
    tmux_options::FLOAT_DRAWER,
    tmux_options::FLOAT_BG,
    tmux_options::FLOAT_NOHEADER,
    tmux_options::SIDEBAR_COLS,
    tmux_options::SIDEBAR_HIDDEN,
    tmux_options::SIDEBAR_ROWS,
    tmux_options::COLLAPSIBLE,
];

pub fn parse_windows(output: &str) -> Vec<WindowRecord> {
    let columns = window_columns();
    output
        .lines()
        .filter_map(|line| {
            let f = record(&columns, line)?;
            let options = WINDOW_OPTION_NAMES
                .iter()
                .filter_map(|name| Some(((*name).to_string(), opt(f[name])?)))
                .collect();
            Some(WindowRecord {
                id: WindowId::parse(f["window_id"]).ok()?,
                index: f["window_index"].parse().ok()?,
                active: f["window_active"] == "1",
                window_type: opt(f[tmux_options::WINDOW_TYPE]),
                float_parent_id: WindowId::parse(f[tmux_options::FLOAT_PARENT].trim()).ok(),
                options,
                layout: restorable_layout(&unescape(f[escaped("window_layout").as_str()])),
                name: unescape(f[escaped("window_name").as_str()]),
            })
        })
        .collect()
}

pub fn parse_panes(output: &str) -> Vec<PaneRecord> {
    let columns = pane_columns();
    output
        .lines()
        .filter_map(|line| {
            let f = record(&columns, line)?;
            let field = |column: &str| f[column];
            let escaped_field = |column: &str| f[escaped(column).as_str()];
            Some(PaneRecord {
                id: PaneId::parse(field("pane_id")).ok()?,
                window_id: WindowId::parse(field("window_id")).ok()?,
                index: field("pane_index").parse().ok()?,
                active: field("pane_active") == "1",
                pid: field("pane_pid").parse().ok()?,
                tty: unescape(escaped_field("pane_tty")),
                cwd: unescape(escaped_field("pane_current_path")),
                restore_command: opt(escaped_field(tmux_options::PANE_RESTORE)),
                group_id: GroupId::parse(escaped_field(tmux_options::GROUP_ID).trim()).ok(),
                group_pos: field(tmux_options::GROUP_POS).trim().parse().ok(),
                offer: offered_by(field(tmux_options::ASK).trim()),
            })
        })
        .collect()
}

/// Assemble a snapshot from the two query outputs and whatever each pane was
/// found to be running (`commands`, keyed by pane id).
pub fn assemble(
    session: &str,
    saved_at: u64,
    windows: Vec<WindowRecord>,
    panes: Vec<PaneRecord>,
    commands: &HashMap<PaneId, Vec<String>>,
) -> Snapshot {
    let index_of: HashMap<&WindowId, u32> = windows.iter().map(|w| (&w.id, w.index)).collect();
    let mut out: Vec<WindowSnapshot> = windows
        .iter()
        .map(|w| {
            let mut ws_panes: Vec<PaneSnapshot> = panes
                .iter()
                .filter(|p| p.window_id == w.id)
                .map(|p| {
                    let mut options = BTreeMap::new();
                    if let Some(gid) = &p.group_id {
                        options.insert(tmux_options::GROUP_ID.to_string(), gid.to_string());
                    }
                    if let Some(pos) = p.group_pos {
                        options.insert(tmux_options::GROUP_POS.to_string(), pos.to_string());
                    }
                    // A sidebar is tmuxy's: what runs in it is the widget
                    // the client started (or, on the right, a shell), never
                    // the helper the widget happens to be sleeping in.
                    let kind = w.window_type.as_deref().and_then(WindowType::parse);
                    let (command, restore_command, offer) = match kind {
                        Some(WindowType::SidebarLeft) => {
                            (None, Some(LEFT_SIDEBAR_WIDGET.to_string()), None)
                        }
                        Some(WindowType::SidebarRight) => (None, None, None),
                        _ => (
                            commands.get(&p.id).cloned(),
                            p.restore_command.clone(),
                            p.offer.clone(),
                        ),
                    };
                    // An old offer only says what the pane was for while
                    // nothing else does.
                    let offer = offer.filter(|_| command.is_none() && restore_command.is_none());
                    PaneSnapshot {
                        index: p.index,
                        active: p.active,
                        cwd: p.cwd.clone(),
                        command,
                        restore_command,
                        options,
                        scrollback: None,
                        offer,
                    }
                })
                .collect();
            ws_panes.sort_by_key(|p| p.index);
            WindowSnapshot {
                index: w.index,
                name: w.name.clone(),
                active: w.active,
                layout: w.layout.clone(),
                window_type: w.window_type.clone(),
                float_parent_index: w
                    .float_parent_id
                    .as_ref()
                    .and_then(|id| index_of.get(id).copied()),
                options: w.options.clone(),
                panes: ws_panes,
            }
        })
        .collect();
    out.sort_by_key(|w| w.index);
    Snapshot {
        version: SNAPSHOT_VERSION,
        session: session.to_string(),
        saved_at,
        windows: out,
        hidden: Vec::new(),
    }
}

/// Whether argv names a shell rather than a program worth bringing back.
pub fn is_shell(argv: &[String]) -> bool {
    argv.first()
        .is_none_or(|first| crate::constants::is_shell_name(first))
}

/// The command to ask `ps` for the processes on a pane's terminal.
///
/// `-t` wants the tty without `/dev/` (`ttys003`, `pts/3`); `tpgid` is the
/// foreground process group of that terminal, which is the part that makes
/// this precise: the job that owns the terminal, not a background one and not
/// a child the shell happens to have.
pub fn ps_args(tty: &str) -> Vec<String> {
    let tty = tty.strip_prefix("/dev/").unwrap_or(tty);
    vec![
        "-ww".to_string(),
        "-t".to_string(),
        tty.to_string(),
        "-o".to_string(),
        "pid=,pgid=,tpgid=,etime=,args=".to_string(),
    ]
}

/// `ps`'s elapsed time (`[[dd-]hh:]mm:ss`) in seconds.
pub fn etime_secs(etime: &str) -> Option<u64> {
    let (days, clock) = match etime.split_once('-') {
        Some((d, rest)) => (d.parse::<u64>().ok()?, rest),
        None => (0, etime),
    };
    let mut secs = 0u64;
    for part in clock.split(':') {
        secs = secs * 60 + part.parse::<u64>().ok()?;
    }
    Some(days * 86_400 + secs)
}

/// The foreground program of a terminal as `ps` reports it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Foreground {
    pub argv: Vec<String>,
    /// How long it has had the terminal, from `ps`'s `etime`.
    pub age_secs: u64,
}

impl Foreground {
    /// Old enough to be the user's program rather than a prompt's helper.
    pub fn settled(&self) -> bool {
        self.age_secs >= MIN_FOREGROUND_AGE_SECS
    }
}

/// The foreground program from `ps` output, or `None` when the shell itself
/// has the terminal (or nothing readable does).
///
/// The foreground job is the process group `tpgid` names. Within it the group
/// leader (`pid == pgid`) is the program the user typed; the rest are its
/// children. The shell is excluded by pid and, as a backstop, by name; a
/// process on its way out (`ps` parenthesises its name) is nobody's program.
pub fn foreground(ps_output: &str, shell_pid: u32) -> Option<Foreground> {
    let mut best: Option<(u32, Foreground)> = None;
    for line in ps_output.lines() {
        let mut it = line.split_whitespace();
        let (Some(pid), Some(pgid), Some(tpgid), Some(etime)) =
            (it.next(), it.next(), it.next(), it.next())
        else {
            continue;
        };
        let (Ok(pid), Ok(pgid), Ok(tpgid)) = (
            pid.parse::<u32>(),
            pgid.parse::<u32>(),
            tpgid.parse::<u32>(),
        ) else {
            continue;
        };
        if pgid != tpgid || pid == shell_pid {
            continue;
        }
        let argv: Vec<String> = it.map(str::to_string).collect();
        if argv.is_empty() || is_shell(&argv) || argv[0].starts_with('(') {
            continue;
        }
        let found = Foreground {
            argv,
            age_secs: etime_secs(etime).unwrap_or(0),
        };
        // The group leader, or failing that the lowest pid in the group.
        let leader = pid == pgid;
        match &best {
            Some((best_pid, _)) if !leader && *best_pid <= pid => {}
            _ => {
                best = Some((pid, found));
                if leader {
                    break;
                }
            }
        }
    }
    best.map(|(_, found)| found)
}
