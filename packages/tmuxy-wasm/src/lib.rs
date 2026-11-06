//! WASM binding over tmuxy-core's sans-IO control-mode client.
//!
//! The browser (v86 or CheerpX running real tmux) feeds raw `tmux -CC`
//! control-mode text into [`WasmTmux::feed`], and the SAME client core the
//! native server runs (`control_mode::MonitorCore`: the parser, the state
//! aggregator, reply correlation, the attach settings, the re-list timers,
//! window sizing) says what to send back, what changed, and what to tell the
//! person. The client's commands are routed by the same policy the native
//! transports apply ([`route_command`], [`route_query`]).
//!
//! No client-side reimplementation, no VT emulator — one source of truth.

use serde::Serialize;
use tmuxy_core::command_router::{self, Route};
use tmuxy_core::control_mode::{
    Action, AttachConfig, ControlModeEvent, Instant, MonitorCore, Notice, Parser,
};
use wasm_bindgen::prelude::*;

#[wasm_bindgen(typescript_custom_section)]
const TYPES: &'static str = r#"
/** What the host does after a feed, a tick or a command. */
export interface Feed {
  /** Control-mode lines to write to tmux, in order. */
  commands: string[];
  /** The state changed: read `snapshot()` for it. */
  changed: boolean;
  /** OSC 52 writes and copy-mode yanks; `paneId` is null for a yank. */
  clipboard: { paneId: string | null; text: string }[];
  /** Notices for the person. */
  messages: string[];
  /** Commands tmux refused. */
  errors: string[];
  /** Answers to the commands run with a reply id. */
  replies: { id: number; output: string; error: string | null }[];
  /** tmux ended the connection (`%exit`); the reason, when it gave one. */
  ended: { reason: string | null } | null;
}

/** Where a client's command goes: to tmux as `routed`, or `blocked`. */
export type Routed = { routed: string } | { blocked: string };
"#;

/// Serialize for JS with maps as plain objects (the delta protocol's
/// `TmuxDelta.panes/windows` are HashMaps, and serde-wasm-bindgen's default
/// ES `Map` is invisible to the frontend) and `None` as `null`, as the wire
/// schema reads it.
fn to_js<T: Serialize>(value: &T) -> Result<JsValue, JsValue> {
    let ser = serde_wasm_bindgen::Serializer::new()
        .serialize_maps_as_objects(true)
        .serialize_missing_as_null(true);
    value
        .serialize(&ser)
        .map_err(|e| JsValue::from_str(&e.to_string()))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Clipboard {
    pane_id: Option<String>,
    text: String,
}

#[derive(Serialize)]
struct Reply {
    id: u32,
    output: String,
    error: Option<String>,
}

#[derive(Serialize)]
struct Ended {
    reason: Option<String>,
}

/// What a feed, tick or command asks of the host (`Feed` in the TS types).
#[derive(Serialize, Default)]
struct Feed {
    commands: Vec<String>,
    changed: bool,
    clipboard: Vec<Clipboard>,
    messages: Vec<String>,
    errors: Vec<String>,
    replies: Vec<Reply>,
    ended: Option<Ended>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
enum Routed {
    Routed(String),
    Blocked(String),
}

impl From<Route> for Routed {
    fn from(route: Route) -> Self {
        match route {
            Route::ControlMode(command) => Routed::Routed(command),
            Route::Blocked(reason) => Routed::Blocked(reason.to_string()),
        }
    }
}

/// The policy the native transports apply to a client's command
/// (`command_router::route_command`): `size` is the viewport a new window is
/// made at, when the client knows it.
#[wasm_bindgen(js_name = routeCommand, unchecked_return_type = "Routed")]
pub fn route_command(
    command: &str,
    session: &str,
    cols: Option<u32>,
    rows: Option<u32>,
) -> Result<JsValue, JsValue> {
    let size = cols.zip(rows);
    to_js(&Routed::from(command_router::route_command(
        command, session, size,
    )))
}

/// The policy for a client's query (`command_router::route_query`): reads
/// only.
#[wasm_bindgen(js_name = routeQuery, unchecked_return_type = "Routed")]
pub fn route_query(command: &str) -> Result<JsValue, JsValue> {
    to_js(&Routed::from(command_router::route_query(command)))
}

struct Session {
    parser: Parser,
    core: MonitorCore<u32>,
    /// Incomplete trailing line carried across `feed` calls (serial arrives in
    /// arbitrary chunks, even byte-by-byte).
    pending: String,
}

impl Session {
    fn new(session_name: &str) -> Self {
        Self {
            parser: Parser::new(),
            // The guest's tmux is the default server, on the PATH.
            core: MonitorCore::new(session_name, "tmux", Instant::now()),
            pending: String::new(),
        }
    }

    /// Run what the core asked for into `out`. The decoded images stay in the
    /// pane's store (served by `image_url`); their placements ride the state.
    fn apply(&mut self, actions: Vec<Action<u32>>, out: &mut Feed) {
        for action in actions {
            match action {
                Action::Send(lines) => out.commands.extend(lines),
                Action::Emit(_) => {
                    out.changed |= self.core.aggregator_mut().to_state_update().is_some();
                }
                Action::Notify(Notice::Images { .. }) => {}
                Action::Notify(Notice::Clipboard { pane_id, text }) => {
                    out.clipboard.push(Clipboard {
                        pane_id: pane_id.map(String::from),
                        text,
                    })
                }
                Action::Notify(Notice::Message(text)) => out.messages.push(text),
                Action::Notify(Notice::Error(error)) => out.errors.push(error),
                Action::Answer(id, reply) => out.replies.push(Reply {
                    id,
                    output: reply.output,
                    error: reply.error,
                }),
                Action::Ended(reason) => out.ended = Some(Ended { reason }),
            }
        }
    }

    fn feed(&mut self, text: &str) -> Feed {
        let mut out = Feed::default();
        self.pending.push_str(text);
        while let Some(nl) = self.pending.find('\n') {
            let mut line: String = self.pending.drain(..=nl).collect();
            while line.ends_with('\n') || line.ends_with('\r') {
                line.pop();
            }
            let Some(event) = self.parser.parse_line(&line) else {
                continue;
            };
            let ended = matches!(event, ControlModeEvent::Exit { .. });
            let actions = self.core.step(event, Instant::now());
            self.apply(actions, &mut out);
            if ended {
                break;
            }
        }
        out
    }

    fn tick(&mut self) -> Feed {
        let mut out = Feed::default();
        let actions = self.core.tick(Instant::now());
        self.apply(actions, &mut out);
        out
    }

    fn run(&mut self, command: &str, reply_id: Option<u32>) -> Feed {
        let outgoing = self.core.command(command, reply_id, Instant::now());
        Feed {
            commands: outgoing.lines.into_iter().chain(outgoing.relists).collect(),
            ..Feed::default()
        }
    }
}

/// The stateful control-mode client exposed to JS.
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

    /// The commands a freshly attached control client sends, the native
    /// monitor's list: the window sizing at `cols`x`rows`, the enforced
    /// settings, flow control, the full re-list and the subscriptions. The
    /// guest image bakes the config in, so there is nothing to source.
    pub fn attach(&self, cols: u32, rows: u32) -> Vec<String> {
        self.inner
            .core
            .attach_commands((cols, rows), AttachConfig::default())
    }

    /// Feed control-mode text the guest wrote.
    #[wasm_bindgen(unchecked_return_type = "Feed")]
    pub fn feed(&mut self, text: &str) -> Result<JsValue, JsValue> {
        to_js(&self.inner.feed(text))
    }

    /// What is due now: the settling flush, the metadata re-list, the
    /// copy-mode poll or heartbeat, replies that ran out of time. Call it at
    /// `next_deadline_ms` or on a short interval.
    #[wasm_bindgen(unchecked_return_type = "Feed")]
    pub fn tick(&mut self) -> Result<JsValue, JsValue> {
        to_js(&self.inner.tick())
    }

    /// Run a client's command, already routed (`routeCommand` or
    /// `routeQuery`): with `reply_id`, its answer comes back in a later
    /// feed's `replies`; without, tmux's refusal comes back in `errors`.
    #[wasm_bindgen(unchecked_return_type = "Feed")]
    pub fn run(&mut self, command: &str, reply_id: Option<u32>) -> Result<JsValue, JsValue> {
        to_js(&self.inner.run(command, reply_id))
    }

    /// The client's viewport: every window is sized to it.
    #[wasm_bindgen(js_name = setClientSize, unchecked_return_type = "Feed")]
    pub fn set_client_size(&mut self, cols: u32, rows: u32) -> Result<JsValue, JsValue> {
        let mut out = Feed::default();
        let actions = self.inner.core.set_client_size(cols, rows);
        self.inner.apply(actions, &mut out);
        to_js(&out)
    }

    /// The full re-list (panes, windows, stash) the state is rebuilt from.
    pub fn resync(&self) -> Vec<String> {
        self.inner
            .core
            .aggregator()
            .markers()
            .window_relist_commands()
            .to_vec()
    }

    /// Follow `session` from now on: the client is about to switch to it.
    #[wasm_bindgen(js_name = expectSession)]
    pub fn expect_session(&mut self, session: &str) {
        self.inner.core.expect_session(session);
    }

    /// The full current `TmuxState`.
    #[wasm_bindgen(unchecked_return_type = "ServerState")]
    pub fn snapshot(&mut self) -> Result<JsValue, JsValue> {
        let state = self.inner.core.aggregator_mut().to_tmux_state();
        to_js(&state)
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
        let pane_id = tmuxy_core::PaneId::parse(pane_id).ok()?;
        self.inner
            .core
            .aggregator()
            .image_data(&pane_id, image_id)
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
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;
    use tmuxy_core::constants::tmux_formats::{RowBuilder, TmuxList, WindowColumn};
    use tmuxy_core::control_mode::{
        CAPTURE_BEGIN_MARKER, CAPTURE_END_MARKER, LIST_BEGIN_MARKER, LIST_END_MARKER,
        REPLY_BEGIN_MARKER, REPLY_END_MARKER,
    };

    /// A command block as tmux answers it.
    fn block(n: u32, body: &str, ok: bool) -> String {
        let end = if ok { "%end" } else { "%error" };
        format!("%begin {n} {n} 1\n{body}{end} {n} {n} 1\n")
    }

    #[test]
    fn feed_reconstructs_panes_and_reports_no_spurious_commands() {
        let mut s = Session::new("m");
        let markers = s.core.aggregator().markers().clone();
        // The aggregator's own marked list, as tmux answers it: three blocks.
        let list = |n: u32, list: TmuxList, rows: &str| {
            format!(
                "{}{}{}",
                block(
                    n,
                    &format!("{} {}\n", markers.tag(LIST_BEGIN_MARKER), list.name()),
                    true
                ),
                block(n + 1, rows, true),
                block(n + 2, &format!("{}\n", markers.tag(LIST_END_MARKER)), true),
            )
        };
        let stream = format!(
            "%begin 1 1 0\n%end 1 1 0\n%session-changed $0 m\n%window-add @0\n{}{}",
            list(
                2,
                TmuxList::Panes,
                "%0,0,0,0,40,24,0,0,1,zsh,,0,0,0,0,@0,,0,0,0,0,0,0,100,,,,,,,\n\
                 %1,1,41,0,39,24,0,0,0,zsh,,0,0,0,0,@0,,0,0,0,0,0,0,100,,,,,,,\n",
            ),
            "%layout-change @0 8205,80x24,0,0{40x24,0,0,0,39x24,41,0,1} \
             8205,80x24,0,0{40x24,0,0,0,39x24,41,0,1} *\n",
        );
        let out = s.feed(&stream);
        // The listed panes are captured; nothing is shown before the
        // windows are listed and those captures have landed.
        let captures = out
            .commands
            .iter()
            .filter(|c| c.contains("capture-pane"))
            .count();
        assert_eq!(captures, 2, "one capture per new pane: {:?}", out.commands);
        assert!(
            !out.changed,
            "nothing to show before the initial sync is complete"
        );

        let capture = |pane: &str| {
            format!(
                "{}{}{}",
                block(
                    4,
                    &format!("{} {pane}\n", markers.tag(CAPTURE_BEGIN_MARKER)),
                    true
                ),
                block(5, "$ \n", true),
                block(6, &format!("{}\n", markers.tag(CAPTURE_END_MARKER)), true),
            )
        };
        let window = RowBuilder::<WindowColumn>::new()
            .set(WindowColumn::WindowId, "@0")
            .set(WindowColumn::Index, 0)
            .set(WindowColumn::Active, 1)
            .set(WindowColumn::WindowType, "tab")
            .set(WindowColumn::Zoomed, 0)
            .set(WindowColumn::Name, "shell")
            .build();
        let synced = s.feed(&format!(
            "{}{}{}",
            list(7, TmuxList::Windows, &format!("{window}\n")),
            capture("0"),
            capture("1")
        ));
        assert!(synced.changed, "the first emission is the complete picture");
        assert_eq!(s.core.aggregator_mut().to_tmux_state().panes.len(), 2);
    }

    /// The guest gets what the native monitor gets: a command run with a
    /// reply id is answered under it, a refused fire-and-forget command is
    /// reported, a `%message` reaches the person and `%exit` ends the feed —
    /// the effects the guest's own loop once dropped.
    #[test]
    fn replies_refusals_messages_and_the_end_reach_the_guest() {
        let mut s = Session::new("m");
        let markers = s.core.aggregator().markers().clone();
        let wrapped = |s: &mut Session, command: &str, id: Option<u32>| {
            let sent = s.run(command, id);
            let begin = sent.commands[0].clone();
            let n: u64 = begin
                .split(&markers.tag(REPLY_BEGIN_MARKER))
                .nth(1)
                .and_then(|rest| rest.trim_end_matches('\'').trim().parse().ok())
                .expect("a wrapped command");
            n
        };
        let id = wrapped(&mut s, "display -p hi", Some(7));
        let answered = s.feed(&format!(
            "{}{}{}",
            block(
                1,
                &format!("{} {id}\n", markers.tag(REPLY_BEGIN_MARKER)),
                true
            ),
            block(2, "hi\n", true),
            block(
                3,
                &format!("{} {id}\n", markers.tag(REPLY_END_MARKER)),
                true
            ),
        ));
        assert!(matches!(
            answered.replies.as_slice(),
            [Reply { id: 7, output, error: None }] if output == "hi"
        ));

        let id = wrapped(&mut s, "splitw -h", None);
        let refused = s.feed(&format!(
            "{}{}{}",
            block(
                4,
                &format!("{} {id}\n", markers.tag(REPLY_BEGIN_MARKER)),
                true
            ),
            block(5, "no space for new pane\n", false),
            block(
                6,
                &format!("{} {id}\n", markers.tag(REPLY_END_MARKER)),
                true
            ),
        ));
        assert_eq!(refused.errors, ["no space for new pane"]);

        let told = s.feed("%message build done\n");
        assert_eq!(told.messages, ["build done"]);

        let ended = s.feed("%exit server exited\n");
        assert!(matches!(ended.ended, Some(Ended { reason: Some(ref r) }) if r == "server exited"));
    }

    /// The attach is the native one: SEC-01's `set-clipboard off` included,
    /// panes listed before windows.
    #[test]
    fn the_attach_is_the_native_monitors() {
        let s = WasmTmux::new("m");
        let attach = s.attach(80, 30);
        assert!(
            attach.contains(&"set set-clipboard 'off'".to_string()),
            "{attach:?}"
        );
        assert!(attach.contains(&"resizew -t 'm' -x 80 -y 30".to_string()));
        let relist = s.resync();
        let at = |command: &String| attach.iter().position(|c| c == command).expect("listed");
        assert!(at(&relist[0]) < at(&relist[1]) && at(&relist[1]) < at(&relist[2]));
    }
}
