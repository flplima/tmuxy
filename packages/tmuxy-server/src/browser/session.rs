//! A named browser session: one engine, and the verbs run against it.
//!
//! The session is owned HERE, by the server, not by the pane that shows it. That
//! is the whole reason the feature can do something the widget cannot: a pane
//! closing, a tab reloading, an SSE connection dropping or a tmux client
//! detaching are all events on the viewing side, and none of them should end a
//! page someone was logged into. A session ends when it is told to.
//!
//! Keyed by name rather than by pane id for the same reason. A name is something
//! a person or a script chose and can say again later (`--session agent1`); a
//! pane id is an accident of which pane happened to be open at the time.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use tokio::sync::Mutex;

use super::discover;
use super::engine::profile_dir;
use super::process::{Engine, EngineError};
use super::verbs::{self, Verb};

/// How long a `wait` verb polls before giving up.
///
/// A deadline rather than a "settle" delay: `wait` exists because the caller
/// knows the thing has not happened yet, so the only honest answer is to keep
/// looking until it does or until this runs out.
const WAIT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);
/// How often `wait` re-asks. Cheap — one `Runtime.evaluate` per tick.
const WAIT_POLL: std::time::Duration = std::time::Duration::from_millis(100);

/// What a verb produced, as the REPL and the CLI print it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Output {
    /// Nothing to say. The verb worked; printing "ok" after every click would
    /// bury the output that matters.
    Silent,
    /// One line.
    Line(String),
    /// Several lines, as the page gave them.
    Text(String),
}

impl std::fmt::Display for Output {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Silent => Ok(()),
            Self::Line(line) => write!(f, "{line}"),
            Self::Text(text) => write!(f, "{text}"),
        }
    }
}

/// Anything that stopped a verb.
#[derive(Debug, thiserror::Error)]
pub enum SessionError {
    #[error("{0}")]
    NoBrowser(#[from] discover::DiscoveryError),
    #[error("{0}")]
    Engine(#[from] EngineError),
    #[error("no element matches `{selector}`")]
    NoSuchElement { selector: String },
    #[error("`{selector}` did not appear within {}s", WAIT_TIMEOUT.as_secs())]
    WaitedTooLong { selector: String },
    #[error("the page refused to evaluate that: {0}")]
    PageThrew(String),
    #[error("could not write {path}: {source}")]
    Write {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
}

/// One browser session.
pub struct Session {
    engine: Engine,
    /// Where `shot` puts a screenshot nobody named a path for.
    shots_dir: PathBuf,
    /// Only for the error message when the profile cannot be cleaned up.
    profile: PathBuf,
}

impl Session {
    /// Start a session, discovering the engine.
    pub async fn start(state_dir: &Path, name: &str) -> Result<Self, SessionError> {
        let browser = discover::find_browser()?;
        let profile = profile_dir(state_dir, name);
        let engine = Engine::launch(&browser, &profile).await?;

        // `Page` has to be enabled before its events arrive, and `Runtime`
        // before `Runtime.evaluate` reports exceptions properly. Both are
        // idempotent and cheap, so they happen at start rather than lazily per
        // verb — a verb that silently enables a domain is a verb whose first
        // call behaves differently from its second.
        engine.send("Page.enable", serde_json::json!({})).await?;
        engine.send("Runtime.enable", serde_json::json!({})).await?;

        Ok(Self {
            engine,
            shots_dir: state_dir.join("browser-shots").join(name),
            profile,
        })
    }

    /// Run one verb.
    pub async fn run(&mut self, verb: Verb) -> Result<Output, SessionError> {
        match verb {
            Verb::Help => Ok(Output::Text(verbs::HELP.to_string())),
            Verb::Goto { url } => self.goto(&url).await,
            Verb::Eval { expression } => self.eval_to_output(&expression).await,
            Verb::Click { selector } => self.click(&selector).await,
            Verb::Type { selector, text } => self.type_into(&selector, &text).await,
            Verb::Wait { selector } => self.wait_for(&selector).await,
            Verb::Title => self.read("document.title").await,
            Verb::Url => self.read("location.href").await,
            Verb::Text { selector } => self.text_of(selector.as_deref()).await,
            Verb::Back => {
                self.eval("history.back()").await?;
                Ok(Output::Silent)
            }
            Verb::Reload => {
                self.engine
                    .send("Page.reload", serde_json::json!({}))
                    .await?;
                Ok(Output::Silent)
            }
            Verb::Shot { path } => self.screenshot(path.as_deref()).await,
        }
    }

    /// Navigate, then report where it landed.
    ///
    /// The URL is echoed rather than staying silent because a redirect is the
    /// normal case, and "I asked for X and got Y" is the single most useful
    /// thing to know after a navigation.
    async fn goto(&mut self, url: &str) -> Result<Output, SessionError> {
        self.engine
            .send("Page.navigate", serde_json::json!({ "url": url }))
            .await?;
        // Settling on `document.readyState` rather than on a `Page.loadEventFired`
        // event: the event may have fired before this call got here, and a wait
        // for an event that already happened never returns.
        let deadline = std::time::Instant::now() + WAIT_TIMEOUT;
        while std::time::Instant::now() < deadline {
            let state = self.eval("document.readyState").await?;
            if state.as_str() == Some("complete") || state.as_str() == Some("interactive") {
                break;
            }
            tokio::time::sleep(WAIT_POLL).await;
        }
        self.read("location.href").await
    }

    /// Click the first match, through the page rather than through a synthetic
    /// mouse event at coordinates.
    ///
    /// `element.click()` is what a selector-shaped request means: it does not
    /// depend on the element being scrolled into view, on nothing overlapping
    /// it, or on the viewport size — all of which a coordinate click does, and
    /// all of which would make the verb fail for reasons the caller cannot see.
    /// Coordinate-level input is what the pane's own forwarding is for.
    async fn click(&mut self, selector: &str) -> Result<Output, SessionError> {
        let found = self
            .eval(&format!(
                "(() => {{ const el = document.querySelector({}); \
                 if (!el) return false; el.click(); return true; }})()",
                json_string(selector)
            ))
            .await?;
        if found.as_bool() == Some(true) {
            Ok(Output::Silent)
        } else {
            Err(SessionError::NoSuchElement {
                selector: selector.to_string(),
            })
        }
    }

    /// Focus a field and set its value, dispatching the events a framework
    /// listens for.
    ///
    /// Assigning `.value` alone is invisible to React, Vue and every other
    /// framework that tracks state from events rather than from the DOM — the
    /// field shows the text and the app does not know it is there, which is the
    /// most confusing possible outcome. So `input` and `change` are dispatched
    /// explicitly.
    async fn type_into(&mut self, selector: &str, text: &str) -> Result<Output, SessionError> {
        let found = self
            .eval(&format!(
                "(() => {{ const el = document.querySelector({}); if (!el) return false; \
                 el.focus(); el.value = {}; \
                 el.dispatchEvent(new Event('input', {{ bubbles: true }})); \
                 el.dispatchEvent(new Event('change', {{ bubbles: true }})); \
                 return true; }})()",
                json_string(selector),
                json_string(text)
            ))
            .await?;
        if found.as_bool() == Some(true) {
            Ok(Output::Silent)
        } else {
            Err(SessionError::NoSuchElement {
                selector: selector.to_string(),
            })
        }
    }

    /// Poll until a selector exists.
    async fn wait_for(&mut self, selector: &str) -> Result<Output, SessionError> {
        let deadline = std::time::Instant::now() + WAIT_TIMEOUT;
        let expression = format!("!!document.querySelector({})", json_string(selector));
        while std::time::Instant::now() < deadline {
            if self.eval(&expression).await?.as_bool() == Some(true) {
                return Ok(Output::Silent);
            }
            tokio::time::sleep(WAIT_POLL).await;
        }
        Err(SessionError::WaitedTooLong {
            selector: selector.to_string(),
        })
    }

    /// The visible text of the page or of one element.
    ///
    /// `innerText`, not `textContent`: the question a caller is asking is "what
    /// does this say", and `textContent` answers with the contents of `<script>`
    /// and `<style>` and every hidden element too.
    async fn text_of(&mut self, selector: Option<&str>) -> Result<Output, SessionError> {
        let expression = match selector {
            Some(selector) => format!(
                "(() => {{ const el = document.querySelector({}); \
                 return el ? el.innerText : null; }})()",
                json_string(selector)
            ),
            None => "document.body?.innerText ?? ''".to_string(),
        };
        let value = self.eval(&expression).await?;
        match value.as_str() {
            Some(text) => Ok(Output::Text(text.to_string())),
            None => match selector {
                Some(selector) => Err(SessionError::NoSuchElement {
                    selector: selector.to_string(),
                }),
                None => Ok(Output::Text(String::new())),
            },
        }
    }

    /// A PNG of the page.
    async fn screenshot(&mut self, path: Option<&str>) -> Result<Output, SessionError> {
        let result = self
            .engine
            .send(
                "Page.captureScreenshot",
                serde_json::json!({ "format": "png" }),
            )
            .await?;
        let encoded = result
            .get("data")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default();
        let bytes = base64_decode(encoded).ok_or_else(|| {
            SessionError::PageThrew("the screenshot came back unreadable".to_string())
        })?;

        let target = match path {
            Some(path) => PathBuf::from(path),
            None => {
                // A name nobody has to choose, and that sorts by time.
                let stamp = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis())
                    .unwrap_or(0);
                self.shots_dir.join(format!("{stamp}.png"))
            }
        };
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|source| SessionError::Write {
                path: target.clone(),
                source,
            })?;
        }
        std::fs::write(&target, bytes).map_err(|source| SessionError::Write {
            path: target.clone(),
            source,
        })?;
        Ok(Output::Line(target.display().to_string()))
    }

    /// Evaluate and print, for the verbs that are a question.
    async fn read(&mut self, expression: &str) -> Result<Output, SessionError> {
        let value = self.eval(expression).await?;
        Ok(Output::Line(render(&value)))
    }

    /// `eval` as a verb: the value, rendered the way a REPL should render it.
    async fn eval_to_output(&mut self, expression: &str) -> Result<Output, SessionError> {
        let value = self.eval(expression).await?;
        Ok(Output::Line(render(&value)))
    }

    /// Evaluate an expression in the page and hand back its value.
    ///
    /// `awaitPromise` so `eval await fetch(...)` works at the prompt — which is
    /// most of what anyone wants to type — and `returnByValue` so the result
    /// arrives as JSON rather than as a remote object handle that would need a
    /// second round trip to read.
    async fn eval(&mut self, expression: &str) -> Result<serde_json::Value, SessionError> {
        let result = self
            .engine
            .send(
                "Runtime.evaluate",
                serde_json::json!({
                    "expression": expression,
                    "returnByValue": true,
                    "awaitPromise": true,
                    // So a bare `await` at the top level parses.
                    "replMode": true,
                }),
            )
            .await?;

        // A page that threw is not a transport failure: the request succeeded
        // and the answer is an exception. Reporting it as such is the difference
        // between "ReferenceError: foo is not defined" and "the browser is
        // gone".
        if let Some(details) = result.get("exceptionDetails") {
            return Err(SessionError::PageThrew(describe_exception(details)));
        }

        Ok(result
            .get("result")
            .and_then(|r| r.get("value"))
            .cloned()
            .unwrap_or(serde_json::Value::Null))
    }

    /// End the session and remove its profile.
    pub async fn close(&mut self) {
        self.engine.shutdown().await;
        // A throwaway profile that is not thrown away is a few hundred MB per
        // session that nothing will ever reclaim.
        if let Err(error) = std::fs::remove_dir_all(&self.profile) {
            if error.kind() != std::io::ErrorKind::NotFound {
                tracing::warn!(
                    target: "tmuxy_server::browser",
                    profile = %self.profile.display(),
                    %error,
                    "could not remove the session profile"
                );
            }
        }
    }
}

/// Every running session, by name.
///
/// The registry is what makes a session outlive the pane showing it: it is held
/// by `AppState`, so it lives as long as the server.
#[derive(Default)]
pub struct Sessions {
    inner: Mutex<HashMap<String, Arc<Mutex<Session>>>>,
}

impl Sessions {
    /// The session called `name`, starting it if it is not running.
    pub async fn get_or_start(
        &self,
        state_dir: &Path,
        name: &str,
    ) -> Result<Arc<Mutex<Session>>, SessionError> {
        // Checked and inserted under one lock, so two panes naming the same
        // session at once cannot each launch an engine — the second would fail
        // on the profile lock, and the failure would look random.
        let mut sessions = self.inner.lock().await;
        if let Some(existing) = sessions.get(name) {
            return Ok(Arc::clone(existing));
        }
        let session = Arc::new(Mutex::new(Session::start(state_dir, name).await?));
        sessions.insert(name.to_string(), Arc::clone(&session));
        Ok(session)
    }

    /// The names of the running sessions.
    pub async fn names(&self) -> Vec<String> {
        let mut names: Vec<String> = self.inner.lock().await.keys().cloned().collect();
        names.sort();
        names
    }

    /// End a session. `false` if it was not running.
    pub async fn close(&self, name: &str) -> bool {
        let Some(session) = self.inner.lock().await.remove(name) else {
            return false;
        };
        // Removed from the map BEFORE closing, so a caller arriving during the
        // shutdown starts a new session rather than waiting on a dying one.
        session.lock().await.close().await;
        true
    }

    /// End every session, for server shutdown.
    pub async fn close_all(&self) {
        let sessions: Vec<_> = self.inner.lock().await.drain().map(|(_, s)| s).collect();
        for session in sessions {
            session.lock().await.close().await;
        }
    }
}

/// A Rust string as a JavaScript string literal.
///
/// Every selector and every piece of text reaches the page inside an expression
/// this process builds, so this is the only thing standing between a selector
/// containing a quote and an expression that means something else entirely.
/// `serde_json` rather than hand-rolled escaping: JSON string syntax is a subset
/// of JavaScript's, and it already handles quotes, backslashes, newlines and
/// control characters.
fn json_string(value: &str) -> String {
    serde_json::Value::String(value.to_string()).to_string()
}

/// A JSON value as a REPL would print it.
///
/// A string prints as itself rather than as `"itself"`: at a prompt, `title`
/// answering `My Page` is what someone wants, and the quotes are noise that a
/// script then has to strip.
fn render(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::Null => "null".to_string(),
        serde_json::Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}

/// A `Runtime.evaluate` exception as one line.
fn describe_exception(details: &serde_json::Value) -> String {
    // The thrown value's own description is the useful part — "ReferenceError:
    // foo is not defined" — and `text` is usually just "Uncaught".
    details
        .get("exception")
        .and_then(|e| e.get("description"))
        .and_then(serde_json::Value::as_str)
        .or_else(|| {
            details
                .get("exception")
                .and_then(|e| e.get("value"))
                .and_then(serde_json::Value::as_str)
        })
        .or_else(|| details.get("text").and_then(serde_json::Value::as_str))
        .unwrap_or("an unknown error")
        .to_string()
}

/// Decode standard base64 without taking a dependency for one call site.
fn base64_decode(encoded: &str) -> Option<Vec<u8>> {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .ok()
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    /// The only thing between a selector containing a quote and an expression
    /// that means something else entirely.
    #[test]
    fn a_string_reaching_the_page_is_escaped() {
        assert_eq!(json_string("#id"), "\"#id\"");
        assert_eq!(
            json_string("a[title=\"x\"]"),
            "\"a[title=\\\"x\\\"]\"",
            "a quote must not close the literal"
        );
        assert_eq!(json_string("back\\slash"), "\"back\\\\slash\"");
        assert_eq!(json_string("two\nlines"), "\"two\\nlines\"");
    }

    /// A selector built to break out of the literal must stay inside it. Not a
    /// trust boundary — the caller already has a shell — but a correctness one:
    /// a page whose content ends up in a selector should not change what the
    /// expression does.
    #[test]
    fn a_selector_cannot_escape_into_the_expression() {
        let hostile = "x\"); alert(1); (\"";
        let escaped = json_string(hostile);

        // The real proof is that the output is ONE well-formed string literal
        // holding exactly the input. If any quote had closed the literal early,
        // the remainder would be trailing garbage and this parse would fail —
        // a substring check cannot tell `\"` from `"` and would pass either
        // way, which is how this test was wrong on the first attempt.
        assert_eq!(
            serde_json::from_str::<String>(&escaped).expect("one valid JSON string"),
            hostile,
            "the page must receive the selector that was asked for"
        );

        // And the literal's own quotes are only at the ends.
        let body = &escaped[1..escaped.len() - 1];
        let mut chars = body.chars().peekable();
        while let Some(c) = chars.next() {
            if c == '\\' {
                chars.next(); // whatever is escaped is not a delimiter
            } else {
                assert_ne!(c, '"', "an unescaped quote inside the literal: {escaped}");
            }
        }
    }

    /// At a prompt, `title` answering `My Page` is what is wanted; the quotes
    /// are noise a script then has to strip.
    #[test]
    fn a_string_result_prints_without_quotes() {
        assert_eq!(render(&serde_json::json!("My Page")), "My Page");
        assert_eq!(render(&serde_json::json!(42)), "42");
        assert_eq!(render(&serde_json::json!(true)), "true");
        assert_eq!(render(&serde_json::json!(null)), "null");
        assert_eq!(render(&serde_json::json!({ "a": 1 })), "{\"a\":1}");
        assert_eq!(render(&serde_json::json!([1, 2])), "[1,2]");
    }

    /// `ReferenceError: foo is not defined` rather than `Uncaught`.
    #[test]
    fn an_exception_reports_the_thrown_value_not_the_wrapper() {
        let details = serde_json::json!({
            "text": "Uncaught",
            "exception": { "description": "ReferenceError: foo is not defined" }
        });
        assert_eq!(
            describe_exception(&details),
            "ReferenceError: foo is not defined"
        );
    }

    /// A thrown string has no `description`, only a `value`.
    #[test]
    fn a_thrown_string_is_still_reported() {
        let details = serde_json::json!({ "exception": { "value": "nope" } });
        assert_eq!(describe_exception(&details), "nope");
    }

    #[test]
    fn an_exception_with_nothing_useful_still_says_something() {
        assert_eq!(
            describe_exception(&serde_json::json!({})),
            "an unknown error"
        );
    }

    #[test]
    fn silent_output_prints_nothing() {
        assert_eq!(Output::Silent.to_string(), "");
        assert_eq!(Output::Line("x".into()).to_string(), "x");
    }

    #[test]
    fn a_wait_that_runs_out_names_the_selector_and_the_budget() {
        let error = SessionError::WaitedTooLong {
            selector: "#late".to_string(),
        };
        let message = error.to_string();
        assert!(message.contains("#late"), "{message}");
        assert!(message.contains("20s"), "{message}");
    }

    #[test]
    fn base64_round_trips_a_png_header() {
        use base64::Engine as _;
        let png = b"\x89PNG\r\n\x1a\n";
        let encoded = base64::engine::general_purpose::STANDARD.encode(png);
        assert_eq!(base64_decode(&encoded).as_deref(), Some(&png[..]));
        assert_eq!(base64_decode("not base64!!"), None);
    }
}
