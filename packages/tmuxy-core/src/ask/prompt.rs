//! The `question` kind of `@tmuxy-ask`: a script or an agent asks the person
//! something (`tmuxy pane ask`) instead of asking to type. Everything else is
//! the send question's: the same option, the same token, the same
//! `needs-input` mark while it is up, the same one-at-a-time turn per pane.
//!
//! The payload is base64 of `{token, kind: "question", caller, question,
//! choices}` for buttons, or `{…, text: true}` for one line of text. A send
//! question's payload has no `kind`, and is untouched by this one.
//!
//! The UI answers `<token>:choice:<n>` (the nth choice, from 0),
//! `<token>:text:<base64>` (what was typed, base64 of UTF-8 so any text rides
//! a tmux option), or `<token>:no` (dismissed), all in `@tmuxy-ask-answer`.
//! A choice comes back by its place, not its text, so an answer can only be
//! one of the choices this asker offered.

use base64::Engine as _;

/// The longest question, in characters.
pub const QUESTION_MAX_CHARS: usize = 500;
/// The most choices a question offers.
pub const CHOICES_MAX: usize = 6;
/// The longest choice, in characters.
pub const CHOICE_MAX_CHARS: usize = 60;
/// The longest caller name the overlay is handed; a longer one is cut.
pub const CALLER_MAX_CHARS: usize = 60;
/// The longest line of text an answer carries; the field takes no more, and
/// a longer one is cut.
pub const ANSWER_MAX_CHARS: usize = 1000;
/// The choices of a question asked with neither choices nor a text field.
const DEFAULT_CHOICES: [&str; 2] = ["Yes", "No"];

/// What a question is answered with.
#[derive(Debug, Clone, PartialEq)]
pub enum Answers {
    /// One button each, in order.
    Choices(Vec<String>),
    /// One line of text, and a Submit button.
    Text,
}

/// A question as `tmuxy pane ask` puts it: checked once, here, so a script's
/// free text can neither break the overlay nor the protocol.
#[derive(Debug, Clone, PartialEq)]
pub struct Prompt {
    question: String,
    answers: Answers,
}

impl Prompt {
    /// The question and how it is answered, or why the command line is
    /// wrong (the CLI's exit 2).
    pub fn new(question: &str, choices: Vec<String>, text: bool) -> Result<Self, String> {
        if text && !choices.is_empty() {
            return Err("--choice and --text do not go together".into());
        }
        if question.trim().is_empty() {
            return Err("a question is required".into());
        }
        plain_text("the question", question, QUESTION_MAX_CHARS)?;
        if choices.len() > CHOICES_MAX {
            return Err(format!(
                "{} choices; a question offers at most {CHOICES_MAX}",
                choices.len()
            ));
        }
        for choice in &choices {
            if choice.trim().is_empty() {
                return Err("a choice cannot be empty".into());
            }
            plain_text(&format!("the choice {choice:?}"), choice, CHOICE_MAX_CHARS)?;
        }
        let answers = match (text, choices.is_empty()) {
            (true, _) => Answers::Text,
            (false, true) => Answers::Choices(DEFAULT_CHOICES.map(String::from).to_vec()),
            (false, false) => Answers::Choices(choices),
        };
        Ok(Self {
            question: question.to_string(),
            answers,
        })
    }

    pub fn question(&self) -> &str {
        &self.question
    }

    pub fn answers(&self) -> &Answers {
        &self.answers
    }

    /// `@tmuxy-ask`'s value for this question from `caller`, pinned by
    /// `token`.
    pub fn encode(&self, token: &str, caller: &str) -> String {
        base64::engine::general_purpose::STANDARD.encode(self.payload(token, caller).to_string())
    }

    /// [`Prompt::encode`]'s payload, before base64.
    pub(super) fn payload(&self, token: &str, caller: &str) -> serde_json::Value {
        let caller: String = caller
            .chars()
            .filter(|c| !c.is_control())
            .take(CALLER_MAX_CHARS)
            .collect();
        let mut payload = serde_json::json!({
            "token": token,
            "kind": "question",
            "caller": caller,
            "question": self.question,
        });
        match &self.answers {
            Answers::Choices(choices) => payload["choices"] = serde_json::json!(choices),
            Answers::Text => payload["text"] = serde_json::json!(true),
        }
        payload
    }

    /// What an answer after `<token>:` says: `Some(Ok(text))` for the chosen
    /// choice's text or the text typed, `Some(Err(()))` for a dismissal, and
    /// `None` for anything this question cannot have been answered with
    /// (kept waiting on, as a stale answer is).
    pub fn read(&self, said: &str) -> Option<Result<String, ()>> {
        if said == "no" {
            return Some(Err(()));
        }
        match &self.answers {
            Answers::Choices(choices) => {
                let index: usize = said.strip_prefix("choice:")?.parse().ok()?;
                choices.get(index).cloned().map(Ok)
            }
            Answers::Text => {
                let encoded = said.strip_prefix("text:")?;
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(encoded)
                    .ok()?;
                let text = String::from_utf8(bytes).ok()?;
                // One line, as the field takes it: anything else on the
                // socket could have written the answer.
                Some(Ok(text
                    .chars()
                    .filter(|c| !c.is_control())
                    .take(ANSWER_MAX_CHARS)
                    .collect()))
            }
        }
    }
}

/// `text` is at most `max` characters and holds no control character (a
/// newline, a tab, an escape): one line the overlay shows as it is.
fn plain_text(what: &str, text: &str, max: usize) -> Result<(), String> {
    let chars = text.chars().count();
    if chars > max {
        return Err(format!(
            "{what} is {chars} characters; at most {max} fit the question"
        ));
    }
    if text.chars().any(char::is_control) {
        return Err(format!(
            "{what} holds a control character (a newline, a tab, an escape): it must be one line of plain text"
        ));
    }
    Ok(())
}
