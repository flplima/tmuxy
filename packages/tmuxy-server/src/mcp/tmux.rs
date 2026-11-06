//! Reads go through `route_query` and mutations through `route_command`
//! (`command_router`), on the monitor's own channel — the same policy and the
//! same path as a browser's commands. A value written into a command line is
//! always a checked id or `tmux_quote`d.

use serde::Serialize;
use std::sync::Arc;
use tmuxy_core::command_router::Route;
use tmuxy_core::constants::tmux_formats::APP_PANE_TITLE;
use tmuxy_core::control_mode::MonitorCommandSender;
use tmuxy_core::session::SessionName;
use tmuxy_core::{tmux_quote, transport, CommandError, PaneId};

use crate::state::AppState;

#[derive(Clone)]
pub(super) struct Tmux {
    state: Arc<AppState>,
    session: SessionName,
    tx: MonitorCommandSender,
}

impl Tmux {
    pub(super) async fn attach(
        state: &Arc<AppState>,
        session: &SessionName,
    ) -> Result<Self, CommandError> {
        let tx = crate::sse::monitor_for_agent(state, session).await?;
        Ok(Self {
            state: Arc::clone(state),
            session: session.clone(),
            tx,
        })
    }

    #[cfg(test)]
    pub(super) fn with_channel(
        state: &Arc<AppState>,
        session: &SessionName,
        tx: MonitorCommandSender,
    ) -> Self {
        Self {
            state: Arc::clone(state),
            session: session.clone(),
            tx,
        }
    }

    pub(super) fn session(&self) -> &SessionName {
        &self.session
    }

    pub(super) async fn keep_alive(&self) {
        crate::sse::hold_for_agent(&self.state, &self.session).await;
    }

    pub(super) async fn viewers(&self) -> usize {
        self.state
            .sessions
            .read()
            .await
            .get(self.session.as_str())
            .map_or(0, |conns| conns.connections.len())
    }

    pub(super) async fn read(&self, command: &str) -> Result<String, CommandError> {
        match transport::route_query(command) {
            Route::Blocked(reason) => Err(CommandError::forbidden(reason)),
            Route::ControlMode(command) => transport::query(&self.tx, &command).await,
        }
    }

    pub(super) async fn mutate(&self, command: &str) -> Result<String, CommandError> {
        let size = crate::sse::new_window_client_size(&self.state, &self.session).await;
        transport::run_with_output(&self.tx, command, &self.session, size).await
    }

    /// The session as a `-t` target: `=` so a prefix never matches another.
    pub(super) fn session_target(&self) -> String {
        tmux_quote(&format!("={}", self.session))
    }

    /// Every pane of the session, tabs, floats and sidebars alike.
    pub(super) async fn panes(&self) -> Result<Vec<Pane>, CommandError> {
        let listing = self
            .read(&format!(
                "list-panes -s -t {} -F {}",
                self.session_target(),
                tmux_quote(&pane_format())
            ))
            .await?;
        Ok(parse_panes(&listing))
    }

    /// The session's tabs: its windows, without the floats and sidebars.
    pub(super) async fn tabs(&self) -> Result<Vec<Tab>, CommandError> {
        let listing = self
            .read(&format!(
                "list-windows -t {} -F {}",
                self.session_target(),
                tmux_quote(TAB_FORMAT)
            ))
            .await?;
        Ok(parse_tabs(&listing))
    }

    /// The pane `target` names in this session — an id, a label or a title —
    /// or the one the user has focused when it names none.
    pub(super) async fn pane(&self, target: Option<&str>) -> Result<Pane, CommandError> {
        resolve_pane(self.panes().await?, target)
    }

    /// The pane a new tab or float opens from: the focused one, unless that
    /// is in a float or a sidebar, and then a pane of a tab — `float-create`
    /// run from a float reuses the float instead of opening one.
    pub(super) async fn anchor(&self) -> Result<Pane, CommandError> {
        let panes: Vec<Pane> = self
            .panes()
            .await?
            .into_iter()
            .filter(|p| p.kind == PaneKind::Tab)
            .collect();
        resolve_pane(panes, None)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum PaneKind {
    Tab,
    Float,
    Sidebar,
}

impl PaneKind {
    /// From the window's `@tmuxy-window-type` (docs/TMUX-TAGS.md).
    fn from_window_type(window_type: &str) -> Self {
        match window_type {
            "float" => Self::Float,
            t if t.starts_with("sidebar") => Self::Sidebar,
            _ => Self::Tab,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Pane {
    pub id: PaneId,
    /// The window it is in: a tab's id, or a float's own window.
    pub tab: String,
    pub kind: PaneKind,
    pub width: u32,
    pub height: u32,
    pub command: String,
    /// The pane the user has focused: the active pane of the current window.
    pub active: bool,
    pub title: String,
    /// `@tmuxy-label` (`tmuxy pane run --label`).
    pub label: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub(super) struct Tab {
    pub id: String,
    pub index: i64,
    pub name: String,
    pub panes: u32,
    pub active: bool,
}

/// The fields `parse_panes` reads, tab-separated, free text last: a tab in a
/// title or label stays in it.
fn pane_format() -> String {
    format!(
        "#{{pane_id}}\t#{{window_id}}\t#{{pane_width}}\t#{{pane_height}}\t\
         #{{&&:#{{pane_active}},#{{window_active}}}}\t#{{@tmuxy-window-type}}\t\
         #{{pane_current_command}}\t#{{@tmuxy-label}}\t{APP_PANE_TITLE}"
    )
}

const TAB_FORMAT: &str = "#{window_id}\t#{window_index}\t#{window_active}\t#{window_panes}\t\
                          #{@tmuxy-window-type}\t#{window_name}";

pub(super) fn parse_panes(listing: &str) -> Vec<Pane> {
    listing
        .lines()
        .filter_map(|line| {
            let f: Vec<&str> = line.splitn(9, '\t').collect();
            let [id, tab, width, height, active, window_type, command, label, title] = f[..] else {
                return None;
            };
            Some(Pane {
                id: PaneId::parse(id).ok()?,
                tab: tab.to_string(),
                kind: PaneKind::from_window_type(window_type),
                width: width.parse().ok()?,
                height: height.parse().ok()?,
                command: command.to_string(),
                active: active == "1",
                title: title.to_string(),
                label: label.to_string(),
            })
        })
        .collect()
}

pub(super) fn parse_tabs(listing: &str) -> Vec<Tab> {
    listing
        .lines()
        .filter_map(|line| {
            let f: Vec<&str> = line.splitn(6, '\t').collect();
            let [id, index, active, panes, window_type, name] = f[..] else {
                return None;
            };
            (PaneKind::from_window_type(window_type) == PaneKind::Tab).then(|| Tab {
                id: id.to_string(),
                index: index.parse().unwrap_or_default(),
                name: name.to_string(),
                panes: panes.parse().unwrap_or_default(),
                active: active == "1",
            })
        })
        .collect()
}

/// The pane a target names among `panes`: a pane id, else a label, else a
/// title — one pane, or an error saying why not. No target is the focused
/// pane.
pub(super) fn resolve_pane(panes: Vec<Pane>, target: Option<&str>) -> Result<Pane, CommandError> {
    let Some(target) = target.map(str::trim).filter(|t| !t.is_empty()) else {
        let mut panes = panes;
        let focused = panes.iter().position(|p| p.active).unwrap_or(0);
        return if panes.is_empty() {
            Err(CommandError::invalid("the session has no panes"))
        } else {
            Ok(panes.swap_remove(focused))
        };
    };
    if let Ok(id) = PaneId::parse(target) {
        return panes
            .into_iter()
            .find(|p| p.id == id)
            .ok_or_else(|| CommandError::invalid(format!("no pane {target} in this session")));
    }
    let by = |matches: &dyn Fn(&Pane) -> bool| -> Vec<Pane> {
        panes.iter().filter(|p| matches(p)).cloned().collect()
    };
    let mut found = by(&|p| p.label == target);
    if found.is_empty() {
        found = by(&|p| p.title == target);
    }
    match found.len() {
        1 => Ok(found.remove(0)),
        0 => Err(CommandError::invalid(format!(
            "no pane labelled or titled {target:?}; pane_list shows them"
        ))),
        n => Err(CommandError::invalid(format!(
            "{n} panes are called {target:?}; name one by its id"
        ))),
    }
}
