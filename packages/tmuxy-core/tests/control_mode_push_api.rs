//! Fixture-based end-to-end test of the sans-IO push API that the wasm/v86 path
//! drives: raw `tmux -CC` control-mode text → `Parser::parse_line` →
//! `StateAggregator::step` → `TmuxState`. Runs in native CI (no browser, no
//! tokio) and exercises the same code the WASM binding reuses verbatim.

use tmuxy_core::control_mode::{Parser, StateAggregator};
use tmuxy_core::TmuxState;

/// Feed a whole control-mode stream line-by-line through the public push API.
fn drive(stream: &str) -> TmuxState {
    let mut parser = Parser::new();
    let mut agg = StateAggregator::with_session_name("m");
    for line in stream.split('\n') {
        if let Some(event) = parser.parse_line(line) {
            agg.step(event);
        }
    }
    agg.to_tmux_state()
}

// A real `tmux -CC` slice: session/window handshake, a list-panes response block
// (fields in LIST_PANES_CMD order), and the window layout — what the browser
// feeds the parser after `attach` + `refresh-client -C`.
const STREAM: &str = concat!(
    "%begin 1 1 0\n",
    "%end 1 1 0\n",
    "%session-changed $0 m\n",
    "%window-add @0\n",
    "%begin 2 2 1\n",
    "%0,0,0,0,40,24,0,0,1,zsh,,0,0,0,0,@0,,0,0,0,0,0,100\n",
    "%1,1,41,0,39,24,0,0,0,zsh,,0,0,0,0,@0,,0,0,0,0,0,100\n",
    "%end 2 2 1\n",
    "%window-pane-changed @0 %0\n",
    "%layout-change @0 8205,80x24,0,0{40x24,0,0,0,39x24,41,0,1} ",
    "8205,80x24,0,0{40x24,0,0,0,39x24,41,0,1} *\n",
);

#[test]
fn reconstructs_two_pane_state_from_control_mode() {
    let state = drive(STREAM);
    assert_eq!(
        state.panes.len(),
        2,
        "expected 2 panes reconstructed from the control-mode stream, got {}",
        state.panes.len()
    );

    let mut widths: Vec<u32> = state.panes.iter().map(|p| p.width).collect();
    widths.sort_unstable();
    assert_eq!(widths, vec![39, 40], "pane geometry from the layout string");

    // Both panes are associated with the window from the list-panes response.
    assert!(state.panes.iter().all(|p| p.window_id == "@0"));
    let ids: Vec<&str> = state.panes.iter().map(|p| p.tmux_id.as_str()).collect();
    assert!(ids.contains(&"%0") && ids.contains(&"%1"));
}

#[test]
fn serializes_to_the_frontend_wire_shape() {
    // The wasm binding hands `StateUpdate`/`TmuxState` to JS via serde; make sure
    // the JSON carries the fields the tmuxy UI reads.
    let state = drive(STREAM);
    let json = serde_json::to_value(&state).expect("serialize TmuxState");
    assert_eq!(json["session_name"], "m");
    assert!(json["panes"].as_array().unwrap().len() == 2);
    assert!(json["panes"][0].get("tmux_id").is_some());
}

#[test]
fn copy_mode_yank_mirrors_paste_buffer_to_clipboard() {
    use tmuxy_core::control_mode::SideEffect;

    let mut parser = Parser::new();
    let mut agg = StateAggregator::with_session_name("m");
    for line in STREAM.split('\n') {
        if let Some(event) = parser.parse_line(line) {
            agg.step(event);
        }
    }

    // A copy-mode yank fires %paste-buffer-changed: the aggregator must ask for
    // the buffer over the control channel, wrapped in sentinel lines.
    let event = parser.parse_line("%paste-buffer-changed buffer0").unwrap();
    let effects = agg.step(event).effects;
    let cmd = effects
        .iter()
        .find_map(|e| match e {
            SideEffect::SendTmuxCommand(c) => Some(c.clone()),
            _ => None,
        })
        .expect("show-buffer command emitted");
    assert!(cmd.contains("TMUXY_BUF_BEGIN") && cmd.contains("show-buffer -b 'buffer0'"));

    // The marker-wrapped response resolves to a WriteClipboard effect with the
    // exact buffer text — never misread as capture-pane output.
    // Each command in the list gets its own %begin/%end block, exactly as
    // tmux 3.7a control mode delivers it.
    let response = concat!(
        "%begin 3 3 1\nTMUXY_BUF_BEGIN\n%end 3 3 1\n",
        "%begin 4 4 1\nyanked line one\nyanked line two\n%end 4 4 1\n",
        "%begin 5 5 1\nTMUXY_BUF_END\n%end 5 5 1\n",
    );
    let mut clipboard: Vec<(String, String)> = Vec::new();
    for line in response.split('\n') {
        if let Some(event) = parser.parse_line(line) {
            for effect in agg.step(event).effects {
                if let SideEffect::WriteClipboard { pane_id, text } = effect {
                    clipboard.push((pane_id, text));
                }
            }
        }
    }
    assert_eq!(clipboard.len(), 1, "exactly one clipboard write");
    assert_eq!(clipboard[0].1, "yanked line one\nyanked line two");
}
