//! Sends waiting in line for a busy pane (`tmuxy pane send --queue`).
//!
//! Each queued send is a pane option of its own, `@tmuxy-send-queued-<id>`,
//! so joining, leaving and retracting are each one set or unset, and two
//! senders never rewrite each other's entry. The id is when it joined and
//! the sender's pid, both zero-padded so the names sort in order; the value
//! is base64 of `{caller, keys, started}`, `started` being when the sender's
//! process started, so a pid reused by another process after the sender died
//! is not taken for the sender.
//!
//! The sender holds its send. It waits until it is first in line and the
//! pane is free (not working, not at a prompt, no other sender's question
//! up), then sends as any send does,
//! the question included, with its entry as the guard's extra condition
//! ([`super::deliver_when`]): a retract that lands before the keys stops
//! them. An entry whose sender is gone is dropped by the next one in line.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine as _;

use super::{at_prompt, display, set_pane, unset_pane, words, Tmux};
use crate::constants::tmux_options::{ASK, PANE_STATE, SEND_QUEUED};
use crate::{CommandError, PaneId, PaneStateName};

const POLL: Duration = Duration::from_millis(250);

/// One send in a pane's line, as `tmuxy pane queue` lists it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Queued {
    pub id: String,
    pub caller: String,
    pub keys: Vec<String>,
    /// Its sender is still running. A gone one's entry is dropped by the
    /// next sender in line.
    pub waiting: bool,
}

/// This sender's own place in a pane's line.
pub struct Entry {
    pane: PaneId,
    id: String,
}

fn option(id: &str) -> String {
    format!("{SEND_QUEUED}-{id}")
}

/// Digits, a dash, digits: anything else names no entry, and never reaches
/// an option name.
fn valid(id: &str) -> bool {
    match id.split_once('-') {
        Some((at, pid)) => {
            !at.is_empty()
                && !pid.is_empty()
                && at.bytes().chain(pid.bytes()).all(|c| c.is_ascii_digit())
        }
        None => false,
    }
}

fn pid_of(id: &str) -> Option<u32> {
    id.rsplit('-').next()?.parse().ok()
}

/// When process `pid` started, in a form only compared for equality: the
/// kernel's start time in ticks where `/proc` has it, else what `ps` says.
/// `None` when there is no such process.
fn started(pid: u32) -> Option<String> {
    if let Ok(stat) = std::fs::read_to_string(format!("/proc/{pid}/stat")) {
        // Field 22; the fields after the command's closing parenthesis
        // start at field 3.
        let after = stat.rsplit_once(')')?.1;
        return after.split_whitespace().nth(19).map(String::from);
    }
    if cfg!(target_os = "linux") {
        return None;
    }
    let out = std::process::Command::new("ps")
        .args(["-o", "lstart=", "-p", &pid.to_string()])
        .env("LC_ALL", "C")
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output()
        .ok()?;
    let said = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (out.status.success() && !said.is_empty()).then_some(said)
}

/// The entry's sender still runs: its pid names a process that started when
/// the sender did, not one that took the pid over after it died.
fn alive(id: &str, sender_started: &str) -> bool {
    !sender_started.is_empty() && pid_of(id).and_then(started).as_deref() == Some(sender_started)
}

struct Payload {
    caller: String,
    keys: Vec<String>,
    started: String,
}

fn decode(value: &str) -> Payload {
    let payload = base64::engine::general_purpose::STANDARD
        .decode(value)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        .unwrap_or_default();
    let text = |field: &str| payload[field].as_str().unwrap_or_default().to_string();
    let keys = payload["keys"]
        .as_array()
        .map(|keys| {
            keys.iter()
                .filter_map(|k| k.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    Payload {
        caller: text("caller"),
        keys,
        started: text("started"),
    }
}

/// The sends in `pane`'s line, first first.
pub async fn list<T: Tmux>(tmux: &T, pane: &PaneId) -> Result<Vec<Queued>, CommandError> {
    let shown = tmux
        .read(words(&["show-options", "-p", "-t", pane.as_str()]))
        .await?;
    let mut line: Vec<Queued> = shown
        .lines()
        .filter_map(|row| {
            let (name, value) = row.split_once(' ')?;
            let id = name.strip_prefix(SEND_QUEUED)?.strip_prefix('-')?;
            if !valid(id) {
                return None;
            }
            let payload = decode(value.trim().trim_matches('"'));
            Some(Queued {
                id: id.to_string(),
                waiting: alive(id, &payload.started),
                caller: payload.caller,
                keys: payload.keys,
            })
        })
        .collect();
    line.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(line)
}

/// Take send `id` out of `pane`'s line: `false` when there is no such send.
pub async fn retract<T: Tmux>(tmux: &T, pane: &PaneId, id: &str) -> Result<bool, CommandError> {
    if !valid(id) || !list(tmux, pane).await?.iter().any(|q| q.id == id) {
        return Ok(false);
    }
    tmux.mutate(vec![unset_pane(pane, &option(id))]).await?;
    Ok(true)
}

/// Not working, not waiting at a prompt for the user, and no other sender's
/// question up: a send that skips the question must not type while the user
/// reads one.
async fn free<T: Tmux>(tmux: &T, pane: &PaneId) -> Result<bool, CommandError> {
    let said = tmux
        .read(display(pane, &format!("#{{{PANE_STATE}}}\t#{{{ASK}}}")))
        .await?;
    let (state, asking) = said
        .trim_end()
        .split_once('\t')
        .unwrap_or((said.trim(), ""));
    Ok(state != PaneStateName::Working.as_str()
        && asking.is_empty()
        && !at_prompt(tmux, pane).await?)
}

impl Entry {
    /// Join the end of `pane`'s line.
    pub async fn join<T: Tmux>(
        tmux: &T,
        pane: &PaneId,
        caller: &str,
        keys: &[String],
    ) -> Result<Self, CommandError> {
        let at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or_default();
        let pid = std::process::id();
        let id = format!("{at:013}-{pid:010}");
        // Without it every other sender would take this entry for a dead one.
        let started = started(pid).ok_or_else(|| {
            CommandError::unavailable(
                "cannot tell when this process started, which a place in line needs; nothing sent",
            )
        })?;
        let payload = serde_json::json!({
            "caller": caller,
            "keys": keys,
            "started": started,
        })
        .to_string();
        let value = base64::engine::general_purpose::STANDARD.encode(payload);
        tmux.mutate(vec![set_pane(pane, &option(&id), &value)])
            .await?;
        Ok(Self {
            pane: pane.clone(),
            id,
        })
    }

    pub fn id(&self) -> &str {
        &self.id
    }

    /// A tmux format, true while this send is still in line: the condition
    /// its keys go in under.
    pub fn condition(&self) -> String {
        format!("#{{{}}}", option(&self.id))
    }

    /// Still in line, not retracted.
    pub async fn in_line<T: Tmux>(&self, tmux: &T) -> Result<bool, CommandError> {
        let value = tmux.read(display(&self.pane, &self.condition())).await?;
        Ok(!value.trim().is_empty())
    }

    /// Wait until this send is first in line and the pane is free: `false`
    /// when it was retracted meanwhile.
    pub async fn wait_turn<T: Tmux>(&self, tmux: &T) -> Result<bool, CommandError> {
        loop {
            let line = list(tmux, &self.pane).await?;
            let Some(place) = line.iter().position(|q| q.id == self.id) else {
                return Ok(false);
            };
            let gone: Vec<_> = line[..place]
                .iter()
                .filter(|q| !q.waiting)
                .map(|q| unset_pane(&self.pane, &option(&q.id)))
                .collect();
            let first = gone.len() == place;
            if !gone.is_empty() {
                tmux.mutate(gone).await?;
            }
            if first && free(tmux, &self.pane).await? {
                return Ok(true);
            }
            tmux.keep_alive().await;
            tokio::time::sleep(POLL).await;
        }
    }

    /// Leave the line once the pane has taken the keys up (it says it is
    /// working) or `within` has passed, so the next send waits for the turn
    /// this one started.
    pub async fn leave_once_taken<T: Tmux>(&self, tmux: &T, within: Duration) {
        let start = tokio::time::Instant::now();
        while start.elapsed() < within {
            let state = tmux
                .read(display(&self.pane, &format!("#{{{PANE_STATE}}}")))
                .await;
            match state {
                Ok(state) if state.trim() != PaneStateName::Working.as_str() => {
                    tokio::time::sleep(POLL).await;
                }
                _ => break,
            }
        }
        self.leave(tmux).await;
    }

    pub async fn leave<T: Tmux>(&self, tmux: &T) {
        let _ = tmux
            .mutate(vec![unset_pane(&self.pane, &option(&self.id))])
            .await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_id_is_digits_a_dash_and_digits() {
        assert!(valid("0001731000000000-42"));
        for bad in [
            "",
            "1",
            "1-",
            "-1",
            "1-2-3",
            "1-x",
            "1 -2",
            "1-2;kill-server",
        ] {
            assert!(!valid(bad), "{bad}");
        }
    }

    #[test]
    fn a_payload_reads_back() {
        let value = base64::engine::general_purpose::STANDARD
            .encode(r#"{"caller":"claude","keys":["it's #[x]","Enter"],"started":"7"}"#);
        let payload = decode(&value);
        assert_eq!(payload.caller, "claude");
        assert_eq!(payload.keys, ["it's #[x]", "Enter"]);
        assert_eq!(payload.started, "7");
        assert!(decode("not base64!").keys.is_empty());
    }

    /// A pid is the sender only while the process behind it started when
    /// the sender did: a pid taken over after the sender died is not it.
    #[test]
    fn a_reused_pid_is_not_the_sender() {
        let me = std::process::id();
        let id = format!("0000000000001-{me:010}");
        let when = started(me).expect("this process has a start time");
        assert!(alive(&id, &when));
        assert!(!alive(&id, "a different start"));
        assert!(!alive(&id, ""));
        assert!(!alive("0000000000001-4294967295", &when));
    }
}
