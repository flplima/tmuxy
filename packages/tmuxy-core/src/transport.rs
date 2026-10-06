//! What both transports do with a live monitor, written once.
//!
//! The web server (`tmuxy-server/src/sse.rs`) and the desktop app
//! (`tmuxy-tauri-app/src/commands.rs`, `monitor.rs`) differ in how they reach
//! a client — an SSE broadcast, a Tauri event — and in nothing else. Every
//! tmux read here rides the monitor's control-mode connection
//! (`MonitorCommand::RunCommandWithReply`): an external `tmux` process while a
//! control-mode client is attached can crash tmux 3.5a (docs/TMUX.md).

use std::collections::HashMap;

use crate::control_mode::{MonitorCommand, MonitorCommandSender, StoredImage, MAX_CLIPBOARD_BYTES};

/// Run a command on the monitor's connection and wait for what it printed. An
/// `%error` from tmux is the `Err`, carrying tmux's message.
pub async fn query(tx: &MonitorCommandSender, command: &str) -> Result<String, String> {
    let (reply, rx) = tokio::sync::oneshot::channel();
    tx.send(MonitorCommand::RunCommandWithReply {
        command: command.to_string(),
        reply,
    })
    .await
    .map_err(|e| format!("Monitor channel error: {e}"))?;
    rx.await
        .map_err(|_| "monitor went away before answering".to_string())?
        .into_result()
}

/// Run a command on the monitor's connection without waiting for it. A
/// `%error` reaches the user through the emitter, not the caller.
pub async fn run(tx: &MonitorCommandSender, command: &str) -> Result<(), String> {
    tx.send(MonitorCommand::RunCommand {
        command: command.to_string(),
    })
    .await
    .map_err(|e| format!("Monitor channel error: {e}"))
}

// ============================================
// Scrollback
// ============================================

/// A range of a pane's scrollback as cells, for copy mode: the
/// `{ cells, historySize, start, end, width }` both transports answer
/// `get_scrollback_cells` with.
///
/// The pane id is the client's and goes into a command line as a target, so
/// it has to be one (`%N`) before it goes anywhere. The width is tmux's, never
/// a guess: a wrong width re-wraps every captured line at the wrong column, so
/// an answer tmux did not give fails and the client asks again.
///
/// One round trip: the pane's geometry and the capture share a command list,
/// so they describe the same moment.
pub async fn scrollback_cells(
    tx: &MonitorCommandSender,
    pane_id: &str,
    start: i64,
    end: i64,
) -> Result<serde_json::Value, String> {
    if !crate::session::is_pane_id(pane_id) {
        return Err(format!("not a pane id: {pane_id:?}"));
    }
    let output = query(
        tx,
        &format!(
            "display-message -p -t {pane_id} '#{{pane_width}} #{{history_size}}' ; \
             capture-pane -p -e -t {pane_id} -S {start} -E {end}"
        ),
    )
    .await
    .map_err(|e| format!("Failed to capture pane range: {e}"))?;
    let (geometry, raw) = output.split_once('\n').unwrap_or((output.as_str(), ""));
    let (width, history_size) = parse_geometry(geometry)?;
    Ok(serde_json::json!({
        "cells": crate::parse_scrollback_to_cells(raw, width),
        "historySize": history_size,
        "start": start,
        "end": end,
        "width": width,
    }))
}

/// `<pane_width> <history_size>`, as the scrollback query prints it.
fn parse_geometry(line: &str) -> Result<(u32, u32), String> {
    let mut fields = line.split_whitespace();
    let width = fields.next().and_then(|w| w.parse::<u32>().ok());
    let history = fields.next().and_then(|h| h.parse::<u32>().ok());
    match (width, history) {
        (Some(width), Some(history)) if width > 0 => Ok((width, history)),
        _ => Err(format!("Failed to parse pane geometry from tmux: {line:?}")),
    }
}

// ============================================
// Images and the clipboard
// ============================================

/// The most a single pane's images may hold in memory.
///
/// A pane used to accumulate images forever: the store is only swept when the
/// PANE goes away, and nothing retires an image whose placement was replaced.
/// That was survivable while an image meant a picture someone `icat`ed, and is
/// not survivable now that `tmuxy browser --repl` draws a JPEG of the page
/// several times a second — the same anchor, a new image id each time, so the
/// placements stay at one while the bytes behind them grow without limit.
///
/// Generous on purpose: this is a backstop against a stream, not a budget for
/// ordinary use. A pane full of distinct pictures in its scrollback stays
/// whole, and a page at 30KB a frame has room for several hundred frames
/// before the oldest is dropped.
pub const MAX_PANE_IMAGE_BYTES: usize = 24 * 1024 * 1024;

/// Decoded picture bytes keyed by `(pane id, image id)`, served back to the
/// client by `/api/images` (web) or the `tmuxyimg:` scheme (desktop).
#[derive(Debug, Default)]
pub struct ImageStore {
    images: HashMap<(String, u32), StoredImage>,
}

impl ImageStore {
    /// Keep a pane's new pictures, then drop its oldest until it is back
    /// under [`MAX_PANE_IMAGE_BYTES`].
    pub fn insert(&mut self, pane_id: &str, images: Vec<(u32, StoredImage)>) {
        for (id, img) in images {
            self.images.insert((pane_id.to_string(), id), img);
        }
        self.trim_pane(pane_id);
    }

    /// Forget every picture of a pane that is no longer in `state`. Called
    /// on a full state, the one update that names every live pane.
    pub fn retain_live_panes(&mut self, state: &crate::TmuxState) {
        let live: std::collections::HashSet<&str> =
            state.panes.iter().map(|p| p.tmux_id.as_str()).collect();
        self.images
            .retain(|(pane_id, _), _| live.contains(pane_id.as_str()));
    }

    pub fn get(&self, pane_id: &str, id: u32) -> Option<&StoredImage> {
        self.images.get(&(pane_id.to_string(), id))
    }

    /// Drop a pane's oldest images until it is back under the cap.
    ///
    /// Oldest by image id, which the core assigns increasing per pane, so the
    /// one dropped first is the one least likely to still be placed on screen.
    /// An image whose placement is live is only dropped if a pane is holding
    /// 24MB of newer images, in which case the alternative was unbounded
    /// growth.
    fn trim_pane(&mut self, pane_id: &str) {
        let mut ids: Vec<(u32, usize)> = self
            .images
            .iter()
            .filter(|((pane, _), _)| pane == pane_id)
            .map(|((_, id), img)| (*id, img.data.len()))
            .collect();
        let mut total: usize = ids.iter().map(|(_, len)| *len).sum();
        if total <= MAX_PANE_IMAGE_BYTES {
            return;
        }
        ids.sort_unstable_by_key(|(id, _)| *id);
        for (id, len) in ids {
            if total <= MAX_PANE_IMAGE_BYTES {
                break;
            }
            if self.images.remove(&(pane_id.to_string(), id)).is_some() {
                total = total.saturating_sub(len);
            }
        }
    }
}

/// Whether a clipboard write may be handed to the client.
///
/// SEC-01/SEC-13: the OSC 52 path is bounded at the aggregator, where the
/// active pane is known; a paste-buffer mirror arrives with no pane at all,
/// so the size cap is applied for both on the way out.
pub fn clipboard_write_allowed(text: &str) -> bool {
    text.len() <= MAX_CLIPBOARD_BYTES
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    /// A monitor that answers every query with `answer`, recording what it
    /// was asked.
    fn answering(
        answer: Result<String, String>,
    ) -> (
        MonitorCommandSender,
        std::sync::Arc<std::sync::Mutex<Vec<String>>>,
    ) {
        let (tx, mut rx) = tokio::sync::mpsc::channel(8);
        let asked = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let seen = asked.clone();
        tokio::spawn(async move {
            while let Some(cmd) = rx.recv().await {
                if let MonitorCommand::RunCommandWithReply { command, reply } = cmd {
                    seen.lock().unwrap().push(command);
                    let (output, error) = match &answer {
                        Ok(out) => (out.clone(), None),
                        Err(e) => (String::new(), Some(e.clone())),
                    };
                    let _ = reply.send(crate::control_mode::CommandReply { output, error });
                }
            }
        });
        (tx, asked)
    }

    #[tokio::test]
    async fn scrollback_is_read_through_the_monitor_in_one_query() {
        let (tx, asked) = answering(Ok("40 120\nhello\nworld\n".to_string()));
        let answer = scrollback_cells(&tx, "%3", -10, -1).await.unwrap();
        assert_eq!(answer["width"], 40);
        assert_eq!(answer["historySize"], 120);
        assert_eq!(answer["start"], -10);
        assert_eq!(answer["end"], -1);
        assert_eq!(answer["cells"].as_array().unwrap().len(), 2);
        let asked = asked.lock().unwrap();
        assert_eq!(asked.len(), 1);
        assert!(asked[0].contains("-t %3 -S -10 -E -1"), "{}", asked[0]);
    }

    /// The width is tmux's or nothing: a guessed 80 re-wraps every captured
    /// line at the wrong column.
    #[tokio::test]
    async fn scrollback_without_a_width_fails_rather_than_guessing() {
        let (tx, _) = answering(Ok("\nhello\n".to_string()));
        assert!(scrollback_cells(&tx, "%3", -10, -1).await.is_err());
    }

    /// The pane id goes into a command line as a target.
    #[tokio::test]
    async fn scrollback_refuses_anything_but_a_pane_id() {
        let (tx, asked) = answering(Ok("40 0\n".to_string()));
        for id in ["other:0.0", "%1 ; kill-server", "{last}", ""] {
            assert!(scrollback_cells(&tx, id, -1, -1).await.is_err(), "{id}");
        }
        assert!(asked.lock().unwrap().is_empty());
    }

    fn picture(len: usize) -> StoredImage {
        StoredImage {
            data: vec![0u8; len],
            mime_type: "image/jpeg".to_string(),
        }
    }

    /// A pane that keeps producing frames must not grow without limit.
    ///
    /// The frame case is the one that bit: `browser --repl` draws at the same
    /// anchor, so the PLACEMENTS stay at one while every frame adds a new
    /// image id — and the store is otherwise only swept when the pane goes
    /// away. The desktop app kept every frame until it was relaunched.
    #[test]
    fn a_pane_streaming_frames_stops_growing_but_keeps_the_newest() {
        let mut store = ImageStore::default();
        // A megabyte a frame, far past the cap.
        for id in 0..40u32 {
            store.insert("%1", vec![(id, picture(1024 * 1024))]);
        }
        let total: usize = store.images.values().map(|img| img.data.len()).sum();
        assert!(
            total <= MAX_PANE_IMAGE_BYTES,
            "a streaming pane must stay under the cap, held {total}"
        );
        assert!(
            store.get("%1", 39).is_some(),
            "the newest frame is the one on screen and must survive"
        );
        assert!(
            store.get("%1", 0).is_none(),
            "the oldest frame is the one to drop"
        );
    }

    #[test]
    fn an_ordinary_pane_of_pictures_is_left_alone() {
        let mut store = ImageStore::default();
        store.insert(
            "%1",
            (0..50u32).map(|id| (id, picture(200 * 1024))).collect(),
        );
        assert_eq!(store.images.len(), 50, "10MB of pictures is under the cap");
    }

    /// One pane's flood must not evict another pane's pictures.
    #[test]
    fn the_cap_is_per_pane() {
        let mut store = ImageStore::default();
        store.insert("%2", vec![(1, picture(1024))]);
        for id in 0..40u32 {
            store.insert("%1", vec![(id, picture(1024 * 1024))]);
        }
        assert!(store.get("%2", 1).is_some());
    }

    /// A pane that has gone takes its pictures with it.
    #[test]
    fn a_full_state_forgets_the_pictures_of_dead_panes() {
        let mut store = ImageStore::default();
        store.insert("%1", vec![(1, picture(10))]);
        store.insert("%2", vec![(1, picture(10))]);
        let state: crate::TmuxState = serde_json::from_value(serde_json::json!({
            "session_name": "s",
            "active_window_id": null,
            "active_pane_id": null,
            "panes": [],
            "windows": [],
            "total_width": 80,
            "total_height": 24,
            "status_line": "",
            "focus_request": null,
        }))
        .unwrap();
        store.retain_live_panes(&state);
        assert!(store.get("%1", 1).is_none());
        assert!(store.get("%2", 1).is_none());
    }

    /// SEC-01/SEC-13, for both transports: the desktop forwarded a clipboard
    /// write of any size.
    #[test]
    fn a_clipboard_write_over_the_cap_is_refused() {
        assert!(clipboard_write_allowed("yanked"));
        assert!(clipboard_write_allowed(&"x".repeat(MAX_CLIPBOARD_BYTES)));
        assert!(!clipboard_write_allowed(
            &"x".repeat(MAX_CLIPBOARD_BYTES + 1)
        ));
    }
}
