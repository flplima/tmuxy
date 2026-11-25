//! Markers: the labelled lines `tmuxy trace --mark` writes, and the slice of a
//! trace that starts at one. Writing and finding a label shorten it the same
//! way ([`marker_label`]), so a label of any length finds its own marker.

use std::path::Path;

use serde_json::{Map, Value};
use tmuxy_core::trace::schema::{field, Layer};

use super::load;

/// The longest label a marker line holds, in characters.
pub(super) const MARKER_LABEL_MAX: usize = 200;

/// A label as a marker stores it. One over the cap keeps its start and its end
/// (in an E2E run, the file and the `› start` / `› fail` suffix) around a
/// digest of the whole, which tells apart labels that differ only in the part
/// left out. A stored label is within the cap, so it reads as itself.
fn marker_label(label: &str) -> String {
    let len = label.chars().count();
    if len <= MARKER_LABEL_MAX {
        return label.to_string();
    }
    // 32-bit FNV-1a: stable from the process that marks to the one that reads.
    let digest = label.bytes().fold(0x811c_9dc5_u32, |hash, byte| {
        (hash ^ u32::from(byte)).wrapping_mul(0x0100_0193)
    });
    let gap = format!(" …{digest:08x}… ");
    let kept = MARKER_LABEL_MAX - gap.chars().count();
    let head: String = label.chars().take(kept / 2).collect();
    let tail: String = label.chars().skip(len - (kept - kept / 2)).collect();
    format!("{head}{gap}{tail}")
}

/// O_APPEND makes this safe alongside a running server's writer; serde
/// escaping keeps the label from breaking the NDJSON framing.
pub(super) fn append_marker(path: &Path, label: &str) -> Result<(), String> {
    use std::io::Write;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let mut line = serde_json::json!({
        field::LAYER: Layer::Marker.as_str(), field::NAME: "mark", "phase": "event",
        field::LABEL: marker_label(label), field::TS_WALL: now
    })
    .to_string();
    line.push('\n');
    let mut file = tmuxy_core::private_files::open_append(path)
        .map_err(|e| format!("{}: {e}", path.display()))?;
    // One write, so the server's lines cannot land inside this one.
    file.write_all(line.as_bytes()).map_err(|e| e.to_string())
}

pub(super) fn is_marker(ev: &Map<String, Value>) -> bool {
    ev.get(field::LAYER).and_then(Value::as_str) == Some(Layer::Marker.as_str())
}

/// The events from the latest marker labelled `label` up to the marker after
/// it. Empty when no marker has that label.
pub(super) fn window(events: &[Map<String, Value>], label: &str) -> Vec<Map<String, Value>> {
    let wanted = marker_label(label);
    let Some(start) = events.iter().rposition(|ev| {
        is_marker(ev) && ev.get(field::LABEL).and_then(Value::as_str) == Some(wanted.as_str())
    }) else {
        return Vec::new();
    };
    events[start..]
        .iter()
        .enumerate()
        .take_while(|(i, ev)| *i == 0 || !is_marker(ev))
        .map(|(_, ev)| ev.clone())
        .collect()
}

/// [`window`] over the trace at `path`, reaching into the rotated backup when
/// the marker is no longer in the file itself.
pub(super) fn load_window(path: &Path, label: &str) -> Result<Vec<Map<String, Value>>, String> {
    let current = load(path)?;
    let found = window(&current, label);
    if !found.is_empty() {
        return Ok(found);
    }
    let backup = tmuxy_core::trace::backup_path(path);
    if !backup.exists() {
        return Ok(found);
    }
    let mut both = load(&backup)?;
    both.extend(current);
    Ok(window(&both, label))
}
