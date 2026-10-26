//! A restored pane's command, offered or run: the `@tmuxy-ask` offer a
//! restore hangs on a pane, and reading one back.

use super::*;

/// A restored pane's command, brought back. Run at once when asked to (or
/// for tmuxy's own sidebar widget); otherwise OFFERED: hung on the pane as an
/// `@tmuxy-ask` question of kind `offer`, which the client draws as a
/// one-line banner and answers by running or dropping it. Typing it instead
/// raced the shell's start-up and showed it twice, and left nothing that said
/// the pane still owed an answer.
pub(super) fn offer_steps(pane: &str, command: &str, run: bool, token: &str) -> Vec<Step> {
    if run {
        return vec![
            Step::Run(argv(&["send-keys", "-t", pane, "-l", command])),
            Step::Run(argv(&["send-keys", "-t", pane, "Enter"])),
        ];
    }
    vec![Step::Run(argv(&[
        "set-option",
        "-p",
        "-t",
        pane,
        tmux_options::ASK,
        &offer_payload(token, command),
    ]))]
}

/// The `@tmuxy-ask` value of an offer: base64 of `{token, kind, command}`,
/// the shape `tmuxy pane send` writes for its own questions.
pub fn offer_payload(token: &str, command: &str) -> String {
    use base64::Engine;
    let json = serde_json::json!({ "token": token, "kind": "offer", "command": command });
    base64::engine::general_purpose::STANDARD.encode(json.to_string())
}

/// The command an `@tmuxy-ask` value offers, when it is an offer at all.
pub fn offered_by(ask: &str) -> Option<String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD.decode(ask).ok()?;
    let value: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    if value.get("kind")?.as_str()? != "offer" {
        return None;
    }
    let command = value.get("command")?.as_str()?;
    (!command.is_empty()).then(|| command.to_string())
}
