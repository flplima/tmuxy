//! The TCP ports a pane's programs listen on: the `:8123` in its tree row.
//!
//! A pane's programs are its process and every process below it. The panes
//! and their first processes come from tmux (`LIST_PANE_PIDS_CMD`), never
//! from a client, so the web cannot ask about a process of its choosing.
//! What is read is the machine's own process table: `/proc` on Linux, one
//! `ps` and one `lsof` elsewhere. It returns nothing for an SSH-backed
//! server, whose panes run on another machine.

use std::collections::{BTreeSet, HashMap, HashSet};

use serde::Serialize;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(not(target_os = "linux"))]
mod other;
#[cfg(any(not(target_os = "linux"), test))]
mod output;

/// Each pane and the process tmux started in it.
pub const LIST_PANE_PIDS_CMD: &str = "list-panes -a -F '#{pane_id} #{pane_pid}'";

/// A pane listening on more than this many ports shows this many: a row has
/// room for a few, and a test runner opening hundreds is not information.
pub const MAX_PORTS_PER_PANE: usize = 8;

/// The ports one pane's programs listen on, lowest first.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PanePorts {
    pub pane_id: String,
    pub ports: Vec<u16>,
}

/// Each pane id and its process id, from a [`LIST_PANE_PIDS_CMD`] listing.
pub fn pane_pids(listing: &str) -> Vec<(String, u32)> {
    listing
        .lines()
        .filter_map(|line| {
            let (pane, pid) = line.trim().split_once(' ')?;
            let pid = pid.trim().parse().ok().filter(|pid| *pid > 1)?;
            pane.starts_with('%').then(|| (pane.to_string(), pid))
        })
        .collect()
}

/// What the machine's process table says: who is whose parent, and which
/// process listens on which ports.
#[derive(Debug, Default)]
pub(crate) struct Processes {
    pub(crate) parents: HashMap<u32, u32>,
    pub(crate) listening: HashMap<u32, Vec<u16>>,
}

/// The ports each pane's programs listen on, for the panes that have any.
pub fn listening_ports(panes: &[(String, u32)]) -> Vec<PanePorts> {
    if panes.is_empty() || crate::session::ssh_target().is_some() {
        return Vec::new();
    }
    let roots: Vec<u32> = panes.iter().map(|(_, pid)| *pid).collect();
    #[cfg(target_os = "linux")]
    let processes = linux::read(&roots);
    #[cfg(not(target_os = "linux"))]
    let processes = other::read(&roots);
    ports_of(panes, &processes)
}

/// [`listening_ports`] over a process table already read.
pub(crate) fn ports_of(panes: &[(String, u32)], processes: &Processes) -> Vec<PanePorts> {
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    for (&pid, &parent) in &processes.parents {
        children.entry(parent).or_default().push(pid);
    }
    panes
        .iter()
        .filter_map(|(pane_id, root)| {
            let mut ports = BTreeSet::new();
            for pid in descendants(*root, &children) {
                if let Some(listening) = processes.listening.get(&pid) {
                    ports.extend(listening.iter().copied());
                }
            }
            (!ports.is_empty()).then(|| PanePorts {
                pane_id: pane_id.clone(),
                ports: ports.into_iter().take(MAX_PORTS_PER_PANE).collect(),
            })
        })
        .collect()
}

/// `root` and every process below it, each once, however the table loops.
pub(crate) fn descendants(root: u32, children: &HashMap<u32, Vec<u32>>) -> Vec<u32> {
    let mut seen = HashSet::from([root]);
    let mut order = vec![root];
    let mut next = 0;
    while let Some(&pid) = order.get(next) {
        next += 1;
        for &child in children.get(&pid).into_iter().flatten() {
            if seen.insert(child) {
                order.push(child);
            }
        }
    }
    order
}

#[cfg(test)]
mod tests;
