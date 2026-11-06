//! The trace's vocabulary, in one place: the layer a Rust event belongs to,
//! how each field key may be recorded, and the names of the events and
//! fields the tools read back (`tmuxy trace --check`,
//! `tmuxy-verbs/src/trace_view/health.rs`). The client's own allowlist
//! (`tmuxy-ui/src/infra/tracer.ts`) is tested against these lists.

/// The layer a line belongs to (docs/TRACING-DESIGN.md). The client names
/// its own (`xstate`, `effect`, `adapter`, …), checked only as identifiers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Layer {
    /// The control-mode connection and the monitor loop: when.
    Monitor,
    /// The state machine over tmux's events: what.
    Aggregator,
    /// The transport's reads and writes of tmux.
    Tmux,
    /// The hosts' state emit: where.
    Emitter,
    /// The rest of the hosts.
    Server,
    /// The rest of tmuxy-core.
    Core,
    /// The trace writer's own lines (an overflow count).
    Trace,
    /// A `tmuxy trace --mark` line.
    Marker,
}

impl Layer {
    pub fn as_str(self) -> &'static str {
        match self {
            Layer::Monitor => "monitor",
            Layer::Aggregator => "aggregator",
            Layer::Tmux => "tmux",
            Layer::Emitter => "emitter",
            Layer::Server => "server",
            Layer::Core => "core",
            Layer::Trace => "trace",
            Layer::Marker => "marker",
        }
    }

    /// The layer of an event from its `tracing` target, by module path: the
    /// aggregator is `tmuxy_core::control_mode::state`, the rest of
    /// `control_mode` the monitor.
    pub fn of_target(target: &str) -> Self {
        let path: Vec<&str> = target.split("::").collect();
        match path.as_slice() {
            ["tmuxy_core", "control_mode", "state", ..] => Layer::Aggregator,
            ["tmuxy_core", "control_mode", ..] => Layer::Monitor,
            ["tmuxy_core", "transport", ..] => Layer::Tmux,
            _ if path.contains(&"emitter") || target == "tmuxy_core::emit" => Layer::Emitter,
            [krate, ..]
                if krate.starts_with("tmuxy_server") || krate.starts_with("tmuxy_tauri") =>
            {
                Layer::Server
            }
            _ => Layer::Core,
        }
    }
}

/// How a field key is recorded. A key in no class is dropped.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FieldClass {
    /// What a line is (layer, name, phase…): an identifier, nothing else.
    Structural,
    /// Content-free: typed variants, ids, counts, timing. Kept as is
    /// (strings scrubbed and bounded).
    Verbatim,
    /// A user-chosen name or path: an opaque hash at `Shape`.
    Hashed,
    /// Free text that may quote a command or output: scrubbed and truncated,
    /// kept (bounded) at `Full`.
    Scrubbed,
    /// A raw command string: only at `Full`, keystrokes redacted.
    FullOnly,
    /// A client's own clock and durations: numbers only.
    ClientNumber,
}

pub const STRUCTURAL: &[&str] = &["layer", "component", "name", "phase", "level"];

pub const VERBATIM: &[&str] = &[
    "op",
    "session",
    "pane",
    "window",
    "seq",
    "conn_id",
    "cols",
    "rows",
    "count",
    "action_id",
    "kind",
    "variant",
    "lagged",
    "code",
    "attempt",
    "max_retries",
    "finished",
    "port",
    "verb",
    // pane lifecycle (aggregator) and session creation (server): sizes and
    // counts only, never the bytes or lines themselves
    "bytes",
    "lines",
    "shell",
    "via",
    "viewers",
    // window-chrome geometry (docs/TRACING.md: tauri layer) — logical px
    "height",
    "y",
];

/// VS Code hashes a folder's git remote rather than its name; un-hashed at
/// `Labeled`/`Full`.
pub const HASHED: &[&str] = &["path"];

pub const SCRUBBED: &[&str] = &["error", "message", "reason"];

/// The command strings whose args can carry arbitrary content (`run-shell`).
pub const FULL_ONLY: &[&str] = &["command", "args"];

pub const CLIENT_NUMBERS: &[&str] = &["ts_wall", "ts_mono", "dur_us"];

pub fn class_of(key: &str) -> Option<FieldClass> {
    [
        (STRUCTURAL, FieldClass::Structural),
        (VERBATIM, FieldClass::Verbatim),
        (HASHED, FieldClass::Hashed),
        (SCRUBBED, FieldClass::Scrubbed),
        (FULL_ONLY, FieldClass::FullOnly),
        (CLIENT_NUMBERS, FieldClass::ClientNumber),
    ]
    .into_iter()
    .find(|(keys, _)| keys.contains(&key))
    .map(|(_, class)| class)
}

/// The fields the tools read back.
pub mod field {
    pub const LAYER: &str = "layer";
    pub const NAME: &str = "name";
    pub const LEVEL: &str = "level";
    pub const SESSION: &str = "session";
    pub const PANE: &str = "pane";
    pub const SHELL: &str = "shell";
    pub const BYTES: &str = "bytes";
    pub const LINES: &str = "lines";
    pub const COLS: &str = "cols";
    pub const ROWS: &str = "rows";
    pub const ERROR: &str = "error";
    pub const TS_WALL: &str = "ts_wall";
    /// A marker's label (written by `tmuxy trace --mark`, not through the
    /// allowlist).
    pub const LABEL: &str = "label";
}

/// The event names the tools read back. The aggregator's pane lifecycle
/// (`control_mode/state`) emits these as its `debug!` messages.
pub mod event {
    pub const PANE_APPEARED: &str = "pane appeared";
    pub const PANE_FIRST_OUTPUT: &str = "pane first output";
    pub const PANE_CAPTURED: &str = "pane captured";
    pub const PANE_RESIZED: &str = "pane resized";
    pub const PANE_GONE: &str = "pane gone";
    /// The monitor's connect span: every one after a session's first is a
    /// reconnect.
    pub const CONNECT: &str = "connect";
    /// A client effect that failed (a command the server refused).
    pub const FAIL: &str = "fail";
    pub const OVERFLOW: &str = "overflow";
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_layer_is_the_module_not_a_substring_of_it() {
        for (target, layer) in [
            (
                "tmuxy_core::control_mode::state::parsing",
                Layer::Aggregator,
            ),
            ("tmuxy_core::control_mode::monitor", Layer::Monitor),
            ("tmuxy_core::control_mode::connection", Layer::Monitor),
            ("tmuxy_core::transport", Layer::Tmux),
            ("tmuxy_core::emit", Layer::Emitter),
            ("tmuxy_server::sse::emitter", Layer::Emitter),
            ("tmuxy_tauri_app::monitor::emitter", Layer::Emitter),
            // An app's own `state` module is not the aggregator.
            ("tmuxy_server::state", Layer::Server),
            ("tmuxy_core::plugins", Layer::Core),
        ] {
            assert_eq!(Layer::of_target(target), layer, "{target}");
        }
    }

    /// What the health check reads off a Rust event is a field the policy
    /// keeps: one it drops can never be there to read.
    #[test]
    fn every_field_the_tools_read_is_recorded() {
        for key in [
            field::LAYER,
            field::NAME,
            field::LEVEL,
            field::SESSION,
            field::PANE,
            field::SHELL,
            field::BYTES,
            field::LINES,
            field::COLS,
            field::ROWS,
            field::ERROR,
            field::TS_WALL,
        ] {
            assert!(class_of(key).is_some(), "{key}");
        }
    }

    #[test]
    fn a_key_has_at_most_one_class() {
        let all = [
            STRUCTURAL,
            VERBATIM,
            HASHED,
            SCRUBBED,
            FULL_ONLY,
            CLIENT_NUMBERS,
        ]
        .concat();
        for key in &all {
            assert_eq!(all.iter().filter(|k| *k == key).count(), 1, "{key}");
        }
    }
}
