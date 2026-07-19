//! WASM binding over tmuxy-core's sans-IO control-mode engine.
//!
//! The browser (v86 running real tmux over serial) feeds raw `tmux -CC`
//! control-mode text into [`WasmTmux::feed`]; the SAME Rust parser + state
//! aggregator the native server uses reconstructs `StateUpdate`s (full/delta)
//! and reports the outbound tmux commands the host must dispatch back to tmux
//! (capture-pane, list-panes, …) to fetch pane content.
//!
//! No client-side reimplementation, no VT emulator — one source of truth.

use serde::Serialize;
use wasm_bindgen::prelude::*;

/// Serialize for JS with maps as plain objects — the delta protocol's
/// `TmuxDelta.panes/windows` are HashMaps, and serde-wasm-bindgen's default
/// (ES `Map`) is invisible to the frontend's object-shaped delta handling.
fn to_js<T: Serialize>(value: &T) -> Result<JsValue, JsValue> {
    let ser = serde_wasm_bindgen::Serializer::new().serialize_maps_as_objects(true);
    value
        .serialize(&ser)
        .map_err(|e| JsValue::from_str(&e.to_string()))
}

use tmuxy_core::constants::tmux_formats;
use tmuxy_core::control_mode::{
    capture_command, ControlModeEvent, Parser, SideEffect, StateAggregator,
};
use tmuxy_core::StateUpdate;

/// Result of feeding a chunk of control-mode text.
#[derive(Serialize, Default)]
struct FeedOutput {
    /// State snapshots/deltas to render (serialized as the tmuxy wire shape).
    updates: Vec<StateUpdate>,
    /// tmux commands the host must send back over the control connection.
    commands: Vec<String>,
    /// OSC 52 clipboard writes: (pane_id, decoded text).
    clipboard: Vec<(String, String)>,
    /// One entry per command response (%begin/%end/%error block) in this feed,
    /// in arrival order: (success, first line of the output, truncated). Lets
    /// the host correlate marker-tagged commands with their outcomes — control
    /// mode replies strictly in the order commands were sent.
    responses: Vec<(bool, String)>,
}

struct Session {
    parser: Parser,
    agg: StateAggregator,
    /// Incomplete trailing line carried across `feed` calls (serial arrives in
    /// arbitrary chunks, even byte-by-byte).
    pending: String,
}

impl Session {
    fn new(session_name: &str) -> Self {
        Self {
            parser: Parser::new(),
            agg: StateAggregator::with_session_name(session_name),
            pending: String::new(),
        }
    }

    fn apply_effects(&mut self, effects: Vec<SideEffect>, out: &mut FeedOutput) {
        for effect in effects {
            match effect {
                SideEffect::EmitState { .. } => {
                    if let Some(update) = self.agg.to_state_update() {
                        out.updates.push(update);
                    }
                }
                SideEffect::SendTmuxCommand(cmd) => out.commands.push(cmd),
                SideEffect::AdoptUntaggedWindows(cmds) => out.commands.extend(cmds),
                SideEffect::RefreshAfterWindowAdd => {
                    out.commands.push(tmux_formats::LIST_PANES_CMD.to_string());
                    out.commands
                        .push(tmux_formats::LIST_WINDOWS_CMD.to_string());
                }
                SideEffect::RefreshPanes { pane_ids } => {
                    let queued = self.agg.queue_captures(&pane_ids);
                    if !queued.is_empty() {
                        out.commands.push(tmux_formats::LIST_PANES_CMD.to_string());
                        for id in &queued {
                            out.commands.push(capture_command(id));
                        }
                    }
                }
                SideEffect::ResumePane(id) => {
                    out.commands
                        .push(format!("refresh-client -A '{id}:continue'"));
                }
                SideEffect::WriteClipboard { pane_id, text } => {
                    out.clipboard.push((pane_id, text));
                }
                // StoreImages: the decoded bytes are already kept in the pane's
                // image store (surfaced via `image_png`); placements ride the
                // snapshot. Flow-control effects are not surfaced yet.
                _ => {}
            }
        }
    }

    fn feed(&mut self, text: &str) -> FeedOutput {
        let mut out = FeedOutput::default();
        self.pending.push_str(text);
        while let Some(nl) = self.pending.find('\n') {
            let mut line: String = self.pending.drain(..=nl).collect();
            while line.ends_with('\n') || line.ends_with('\r') {
                line.pop();
            }
            let Some(event) = self.parser.parse_line(&line) else {
                continue;
            };
            if let ControlModeEvent::CommandResponse {
                output, success, ..
            } = &event
            {
                let first = output.lines().next().unwrap_or("");
                let first = first.chars().take(120).collect::<String>();
                out.responses.push((*success, first));
            }
            let effects = self.agg.step(event).effects;
            self.apply_effects(effects, &mut out);
        }
        out
    }

    /// Drain the settling-debounce timer. Pane-output updates are debounced by
    /// the aggregator and emitted here, so hosts must call this on a timer.
    fn tick(&mut self) -> FeedOutput {
        let mut out = FeedOutput::default();
        let effects = self.agg.tick_now();
        self.apply_effects(effects, &mut out);
        out
    }
}

/// The stateful control-mode engine exposed to JS.
#[wasm_bindgen]
pub struct WasmTmux {
    inner: Session,
}

#[wasm_bindgen]
impl WasmTmux {
    #[wasm_bindgen(constructor)]
    pub fn new(session_name: &str) -> WasmTmux {
        WasmTmux {
            inner: Session::new(session_name),
        }
    }

    /// Feed control-mode text; returns `{ updates: StateUpdate[], commands: string[] }`.
    pub fn feed(&mut self, text: &str) -> Result<JsValue, JsValue> {
        let out = self.inner.feed(text);
        to_js(&out)
    }

    /// Drain the settling-debounce timer (call on a ~50ms interval). Returns the
    /// same `{ updates, commands }` shape. Debounced pane-output updates surface
    /// here rather than from `feed`.
    pub fn tick(&mut self) -> Result<JsValue, JsValue> {
        let out = self.inner.tick();
        to_js(&out)
    }

    /// The full current `TmuxState` snapshot (convenient for rendering; deltas
    /// from `feed` are the efficient path once wired to the real UI).
    pub fn snapshot(&mut self) -> Result<JsValue, JsValue> {
        let state = self.inner.agg.to_tmux_state();
        to_js(&state)
    }

    /// The commands a host should send once after attaching, to do a full sync
    /// (list-panes + list-windows) — tmux doesn't replay these on attach, so
    /// without them there's no active window/pane. Order matches the native
    /// monitor (panes before windows).
    pub fn initial_sync(&self) -> Vec<String> {
        vec![
            tmux_formats::LIST_PANES_CMD.to_string(),
            tmux_formats::LIST_WINDOWS_CMD.to_string(),
        ]
    }

    /// Parse raw `capture-pane -p -e` scrollback text into structured cells.
    /// Client-side copy mode fetches history this way: the host runs
    /// capture-pane over the control connection, collects the block, and hands
    /// the text here so the same core ANSI parser used for live panes produces
    /// the scrollback cells (no JS-side vt100 reimplementation).
    pub fn parse_scrollback(&self, text: &str, width: u32) -> Result<JsValue, JsValue> {
        to_js(&tmuxy_core::parse_scrollback_to_cells(text, width))
    }

    /// A `data:` URL for a pane's image placement, or undefined if unknown.
    /// Wire `window.__tmuxyImageSrc` to this so inline terminal images render
    /// with no server. `pane_id` is the tmux id (e.g. "%0").
    pub fn image_url(&self, pane_id: &str, image_id: u32) -> Option<String> {
        use base64::Engine;
        self.inner
            .agg
            .image_data(pane_id, image_id)
            .map(|(data, mime)| {
                format!(
                    "data:{};base64,{}",
                    mime,
                    base64::engine::general_purpose::STANDARD.encode(data)
                )
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn feed_reconstructs_panes_and_reports_no_spurious_commands() {
        let mut s = Session::new("m");
        let stream = concat!(
            "%begin 1 1 0\n%end 1 1 0\n%session-changed $0 m\n%window-add @0\n",
            "%begin 2 2 1\n",
            "%0,0,0,0,40,24,0,0,1,zsh,,0,0,0,0,@0,,0,0,0,0,0,100\n",
            "%1,1,41,0,39,24,0,0,0,zsh,,0,0,0,0,@0,,0,0,0,0,0,100\n",
            "%end 2 2 1\n",
            "%layout-change @0 8205,80x24,0,0{40x24,0,0,0,39x24,41,0,1} ",
            "8205,80x24,0,0{40x24,0,0,0,39x24,41,0,1} *\n",
        );
        let out = s.feed(stream);
        assert!(
            !out.updates.is_empty(),
            "should emit at least one StateUpdate"
        );
        // Every %begin/%end block surfaces as a response for host-side
        // command correlation (two blocks in this stream, both successful).
        assert_eq!(out.responses.len(), 2);
        assert!(out.responses.iter().all(|(ok, _)| *ok));

        // An %error block surfaces as a failed response with its message.
        let err = s.feed("%begin 3 3 1\ncan't find session: nope\n%error 3 3 1\n");
        assert_eq!(err.responses.len(), 1);
        assert!(!err.responses[0].0);
        assert!(err.responses[0].1.contains("can't find session"));
    }
}
