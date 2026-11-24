//! What a `needs-input` agent event says the user is asked, for
//! `@tmuxy-pane-status`: the hook script writes it beside the state.

use serde_json::Value;

use super::Agent;

/// The second line of `tmuxy agent state`, for the hook script
/// (`packages/tmuxy-cli/bin/tmuxy/agent-hook`): what the user is asked, `-`
/// to take what they were asked off the pane, or nothing to leave it as it
/// is. Every state but `needs-input` takes it off, so an answered question
/// never shows again; a `needs-input` that says nothing more (Claude Code's
/// later permission notification) leaves the question that is up.
pub fn status_line(agent: Agent, event: &str, payload: &Value, state: &str) -> Option<String> {
    if state != tmuxy_core::PaneStateName::NeedsInput.as_str() {
        return Some("-".to_string());
    }
    question_status(agent, event, payload)
}

/// What the user is asked, for a `needs-input` event that says: the
/// question, or the tool and what it would do. A report body for
/// `@tmuxy-pane-status` ([`tmuxy_core::control_mode::blocked_status`]), so the
/// pane's mark and a push notification show the question itself.
///
/// Claude Code's permission notification says only that it needs permission,
/// and comes seconds after `PermissionRequest` said what for: it has none.
pub fn question_status(agent: Agent, event: &str, payload: &Value) -> Option<String> {
    let field = |key: &str| payload.get(key).and_then(Value::as_str).unwrap_or("");
    let (kind, text) = match (agent, event) {
        (_, "PermissionRequest") | (Agent::Claude, "PreToolUse") => tool_question(payload)?,
        (Agent::Claude, "Notification") => match field("notification_type") {
            "elicitation_dialog" | "elicitation_url_dialog" | "agent_needs_input" => {
                ("question", field("message").to_string())
            }
            _ => return None,
        },
        _ => return None,
    };
    tmuxy_core::control_mode::blocked_status(kind, agent.name(), &text)
}

/// The question a tool call puts to the user: the question it asks, or the
/// tool with what it would do (the command, the file, the address).
fn tool_question(payload: &Value) -> Option<(&'static str, String)> {
    let tool = payload.get("tool_name").and_then(Value::as_str)?;
    let input = payload.get("tool_input").unwrap_or(&Value::Null);
    let text = |key: &str| {
        match input.get(key) {
            Some(Value::String(text)) => Some(text.clone()),
            // Codex hands a command over as its argv.
            Some(Value::Array(words)) => Some(
                words
                    .iter()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>()
                    .join(" "),
            ),
            _ => None,
        }
        .filter(|text| !text.trim().is_empty())
    };
    match tool {
        "AskUserQuestion" => {
            let questions = input.get("questions").and_then(Value::as_array)?;
            let first = questions.first()?.get("question").and_then(Value::as_str)?;
            let text = match questions.len() {
                1 => first.to_string(),
                n => format!("{first} (+{} more)", n - 1),
            };
            Some(("question", text))
        }
        "ExitPlanMode" => {
            let heading = text("plan").and_then(|plan| {
                plan.lines()
                    .map(|line| line.trim_start_matches('#').trim())
                    .find(|line| !line.is_empty())
                    .map(str::to_string)
            });
            let text = match heading {
                Some(heading) => format!("Approve the plan: {heading}"),
                None => "Approve the plan".to_string(),
            };
            Some(("permission", text))
        }
        _ => {
            let what = [
                "command",
                "file_path",
                "notebook_path",
                "url",
                "pattern",
                "query",
            ]
            .iter()
            .find_map(|key| text(key));
            let text = match what {
                Some(what) => format!("Allow {tool}: {what}"),
                None => format!("Allow {tool}"),
            };
            Some(("permission", text))
        }
    }
}
