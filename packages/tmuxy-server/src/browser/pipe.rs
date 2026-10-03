//! CDP over a pipe: framing, and the request/reply bookkeeping on top of it.
//!
//! The DevTools Protocol is usually spoken over a WebSocket, reached through an
//! HTTP endpoint on `--remote-debugging-port`. tmuxy does not use that, because
//! the endpoint is an unauthenticated full-control API — anything on the machine
//! that can reach it reads every cookie in the profile, runs script in any page
//! and navigates to `file://` URLs. A port is a thing other processes can find;
//! `--remote-debugging-pipe` is not.
//!
//! Chromium's pipe transport is deliberately simple: the browser reads requests
//! from file descriptor 3 and writes responses and events to file descriptor 4,
//! as UTF-8 JSON objects separated by NUL bytes. There is no handshake, no
//! length prefix and no framing beyond the separator. That is the whole wire
//! format, and it is why implementing it here is smaller than taking on a CDP
//! client library — `chromiumoxide`, the obvious candidate, speaks only the
//! WebSocket transport and would have meant choosing a port after all.
//!
//! This module is the framing and the correlation. Spawning the browser and the
//! commands worth sending it live in `session`.

use std::collections::VecDeque;

/// The file descriptor Chromium reads CDP requests from.
///
/// Fixed by Chromium, not chosen here: `--remote-debugging-pipe` means fd 3 in,
/// fd 4 out, and nothing negotiates it.
pub const CDP_READ_FD: i32 = 3;
/// The file descriptor Chromium writes CDP responses and events to.
pub const CDP_WRITE_FD: i32 = 4;

/// The separator between messages in both directions.
const NUL: u8 = 0;

/// Splits a byte stream into whole CDP messages.
///
/// Reads arrive in whatever sizes the kernel hands over, which has nothing to do
/// with message boundaries: one read can carry half a message, three messages,
/// or two and a half. Everything after the last NUL is an incomplete message and
/// has to be held until the rest of it arrives — the bug this type exists to not
/// have is treating that tail as a message and failing to parse it.
#[derive(Debug, Default)]
pub struct MessageReader {
    /// Bytes seen but not yet terminated by a NUL.
    partial: Vec<u8>,
    /// Complete messages, oldest first.
    ready: VecDeque<Vec<u8>>,
}

impl MessageReader {
    pub fn new() -> Self {
        Self::default()
    }

    /// Feed bytes from a read. Complete messages become available to `pop`.
    pub fn feed(&mut self, bytes: &[u8]) {
        for chunk in bytes.split_inclusive(|b| *b == NUL) {
            match chunk.split_last() {
                // Terminated: whatever was held plus this chunk is one message.
                Some((&NUL, body)) => {
                    let mut message = std::mem::take(&mut self.partial);
                    message.extend_from_slice(body);
                    // A NUL with nothing before it is a keepalive, not a
                    // message — forwarding an empty body would reach the JSON
                    // parser as an error about input nobody sent.
                    if !message.is_empty() {
                        self.ready.push_back(message);
                    }
                }
                // No terminator: the tail of this read is the head of a message
                // whose rest has not arrived.
                _ => self.partial.extend_from_slice(chunk),
            }
        }
    }

    /// The next complete message, if one has arrived.
    pub fn pop(&mut self) -> Option<Vec<u8>> {
        self.ready.pop_front()
    }

    /// How many bytes are held waiting for a terminator.
    ///
    /// Exposed because an unbounded partial is how a wedged or hostile peer
    /// turns a stream into a memory leak, and the caller is the one that can
    /// decide to give up on the connection.
    pub fn pending_bytes(&self) -> usize {
        self.partial.len()
    }
}

/// Frame one CDP request for the wire.
pub fn frame(payload: &[u8]) -> Vec<u8> {
    let mut framed = Vec::with_capacity(payload.len() + 1);
    framed.extend_from_slice(payload);
    framed.push(NUL);
    framed
}

/// What came back from the browser on the read side.
///
/// A reply carries the `id` of the request it answers; an event carries a
/// `method` and no `id`. Telling them apart by the presence of `id` is the
/// protocol's own rule, not a heuristic.
#[derive(Debug, Clone, PartialEq)]
pub enum Incoming {
    /// A reply to a request this side sent.
    Reply {
        id: u64,
        /// `Ok` with the result object, or `Err` with the browser's message.
        outcome: Result<serde_json::Value, String>,
    },
    /// Something the browser reported on its own: a screencast frame, a
    /// navigation, a console message.
    Event {
        method: String,
        params: serde_json::Value,
    },
    /// Well-formed JSON that is neither — a protocol addition, or a message for
    /// a feature this build does not use. Kept rather than dropped silently so
    /// an unexpected shape is debuggable instead of invisible.
    Unknown(serde_json::Value),
}

/// Parse one message from the browser.
pub fn parse(message: &[u8]) -> Result<Incoming, serde_json::Error> {
    let value: serde_json::Value = serde_json::from_slice(message)?;

    if let Some(id) = value.get("id").and_then(serde_json::Value::as_u64) {
        // An error reply carries `error`, not `result`. Both can be absent: a
        // command with no return value answers `{"id":N}`, which is a success.
        let outcome = match value.get("error") {
            Some(error) => Err(describe_error(error)),
            None => Ok(value
                .get("result")
                .cloned()
                .unwrap_or(serde_json::Value::Null)),
        };
        return Ok(Incoming::Reply { id, outcome });
    }

    if let Some(method) = value.get("method").and_then(serde_json::Value::as_str) {
        return Ok(Incoming::Event {
            method: method.to_string(),
            params: value
                .get("params")
                .cloned()
                .unwrap_or(serde_json::Value::Null),
        });
    }

    Ok(Incoming::Unknown(value))
}

/// A CDP error as a line worth putting in front of a user.
///
/// The protocol's errors carry a `message` and often a `data` with the part that
/// actually says what was wrong — a bad selector, a navigation that was
/// cancelled. Dropping `data` loses the half that is specific.
fn describe_error(error: &serde_json::Value) -> String {
    let message = error
        .get("message")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("unknown CDP error");
    match error.get("data").and_then(serde_json::Value::as_str) {
        Some(data) if !data.is_empty() => format!("{message}: {data}"),
        _ => message.to_string(),
    }
}

/// Allocates the `id` field for outgoing requests.
///
/// Monotonic and never reused: an id that comes round again could match a reply
/// to a request that timed out, and the answer to the old question would be
/// handed to whoever asked the new one.
#[derive(Debug, Default)]
pub struct RequestIds(u64);

impl RequestIds {
    pub fn next_id(&mut self) -> u64 {
        self.0 += 1;
        self.0
    }
}

#[cfg(test)]
// A test's `expect` IS its assertion: the panic message is the failure report.
// CI does not lint test code (docs/TESTS.md, Known Gaps); this is for whoever
// runs clippy with --tests.
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;
    use serde_json::json;

    fn collect(reader: &mut MessageReader) -> Vec<String> {
        let mut out = Vec::new();
        while let Some(message) = reader.pop() {
            out.push(String::from_utf8(message).expect("utf-8"));
        }
        out
    }

    #[test]
    fn a_whole_message_arrives_whole() {
        let mut reader = MessageReader::new();
        reader.feed(b"{\"id\":1}\0");
        assert_eq!(collect(&mut reader), vec!["{\"id\":1}"]);
    }

    #[test]
    fn several_messages_in_one_read_all_arrive() {
        let mut reader = MessageReader::new();
        reader.feed(b"{\"a\":1}\0{\"b\":2}\0{\"c\":3}\0");
        assert_eq!(
            collect(&mut reader),
            vec!["{\"a\":1}", "{\"b\":2}", "{\"c\":3}"]
        );
    }

    /// The bug this type exists to not have: a read whose tail is half a
    /// message. Treating the tail as a message hands the JSON parser input
    /// nobody sent.
    #[test]
    fn a_message_split_across_reads_is_reassembled() {
        let mut reader = MessageReader::new();
        reader.feed(b"{\"id\"");
        assert!(collect(&mut reader).is_empty(), "nothing is complete yet");
        reader.feed(b":42,\"res");
        assert!(collect(&mut reader).is_empty());
        reader.feed(b"ult\":{}}\0");
        assert_eq!(collect(&mut reader), vec!["{\"id\":42,\"result\":{}}"]);
    }

    #[test]
    fn a_read_carrying_two_messages_and_half_of_a_third_yields_two() {
        let mut reader = MessageReader::new();
        reader.feed(b"{\"a\":1}\0{\"b\":2}\0{\"c\"");
        assert_eq!(collect(&mut reader), vec!["{\"a\":1}", "{\"b\":2}"]);
        assert!(reader.pending_bytes() > 0, "the third is still held");
        reader.feed(b":3}\0");
        assert_eq!(collect(&mut reader), vec!["{\"c\":3}"]);
        assert_eq!(reader.pending_bytes(), 0);
    }

    /// A lone NUL is not a message. Forwarding an empty body would reach the
    /// JSON parser as an error about input the peer never sent.
    #[test]
    fn a_lone_separator_is_not_a_message() {
        let mut reader = MessageReader::new();
        reader.feed(b"\0\0{\"a\":1}\0\0");
        assert_eq!(collect(&mut reader), vec!["{\"a\":1}"]);
    }

    /// A multi-byte character can straddle a read boundary, and the framing
    /// must not care: it splits on NUL, which never appears inside UTF-8.
    #[test]
    fn a_character_split_across_reads_survives() {
        let text = "{\"t\":\"café ❯\"}";
        let bytes = text.as_bytes();
        let mut reader = MessageReader::new();
        for i in 0..bytes.len() {
            reader.feed(&bytes[i..=i]);
        }
        reader.feed(b"\0");
        assert_eq!(collect(&mut reader), vec![text]);
    }

    #[test]
    fn framing_appends_exactly_one_separator() {
        assert_eq!(frame(b"{}"), b"{}\0".to_vec());
    }

    #[test]
    fn a_framed_message_round_trips_through_the_reader() {
        let payload = json!({ "id": 7, "method": "Page.navigate" });
        let bytes = serde_json::to_vec(&payload).expect("serialize");
        let mut reader = MessageReader::new();
        reader.feed(&frame(&bytes));
        let back = reader.pop().expect("one message");
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&back).expect("parse"),
            payload
        );
    }

    #[test]
    fn a_result_reply_is_a_reply() {
        let parsed = parse(br#"{"id":3,"result":{"frameId":"F1"}}"#).expect("parse");
        assert_eq!(
            parsed,
            Incoming::Reply {
                id: 3,
                outcome: Ok(json!({ "frameId": "F1" })),
            }
        );
    }

    /// A command with no return value answers `{"id":N}`. That is a success,
    /// not a malformed reply — reading it as an error would fail every
    /// navigation and every input event.
    #[test]
    fn a_reply_with_no_result_is_still_a_success() {
        let parsed = parse(br#"{"id":4}"#).expect("parse");
        assert_eq!(
            parsed,
            Incoming::Reply {
                id: 4,
                outcome: Ok(serde_json::Value::Null),
            }
        );
    }

    /// `data` carries the half of a CDP error that is actually specific.
    #[test]
    fn an_error_reply_keeps_the_specific_half() {
        let parsed =
            parse(br#"{"id":5,"error":{"code":-32000,"message":"Cannot find context","data":"no such frame"}}"#)
                .expect("parse");
        assert_eq!(
            parsed,
            Incoming::Reply {
                id: 5,
                outcome: Err("Cannot find context: no such frame".to_string()),
            }
        );
    }

    #[test]
    fn an_error_without_data_reads_as_its_message() {
        let parsed = parse(br#"{"id":6,"error":{"message":"Target closed"}}"#).expect("parse");
        assert_eq!(
            parsed,
            Incoming::Reply {
                id: 6,
                outcome: Err("Target closed".to_string()),
            }
        );
    }

    /// The protocol's own rule: no `id` means the browser is telling you
    /// something rather than answering you.
    #[test]
    fn a_message_without_an_id_is_an_event() {
        let parsed =
            parse(br#"{"method":"Page.screencastFrame","params":{"sessionId":2}}"#).expect("parse");
        assert_eq!(
            parsed,
            Incoming::Event {
                method: "Page.screencastFrame".to_string(),
                params: json!({ "sessionId": 2 }),
            }
        );
    }

    #[test]
    fn an_event_with_no_params_is_still_an_event() {
        let parsed = parse(br#"{"method":"Inspector.detached"}"#).expect("parse");
        assert!(matches!(parsed, Incoming::Event { .. }));
    }

    /// A shape that is neither is kept, not dropped: a protocol addition should
    /// be debuggable rather than invisible.
    #[test]
    fn an_unrecognised_shape_is_kept() {
        let parsed = parse(br#"{"something":"else"}"#).expect("parse");
        assert_eq!(parsed, Incoming::Unknown(json!({ "something": "else" })));
    }

    #[test]
    fn a_body_that_is_not_json_is_an_error() {
        assert!(parse(b"not json").is_err());
    }

    /// An id that came round again could match a reply to a request that timed
    /// out, handing the answer to the old question to whoever asked the new one.
    #[test]
    fn request_ids_never_repeat() {
        let mut ids = RequestIds::default();
        let issued: Vec<u64> = (0..1000).map(|_| ids.next_id()).collect();
        let unique: std::collections::BTreeSet<u64> = issued.iter().copied().collect();
        assert_eq!(unique.len(), issued.len(), "an id was reused");
        assert!(issued.windows(2).all(|w| w[0] < w[1]), "ids must increase");
        assert_ne!(
            issued[0], 0,
            "0 is a real id in CDP; do not hand it out as a sentinel"
        );
    }
}
