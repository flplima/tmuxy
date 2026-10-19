use std::path::PathBuf;

use chromiumoxide::cdp::browser_protocol::page::{
    CaptureScreenshotFormat, CaptureScreenshotParams, NavigateParams,
};

use super::{Attachment, Output, Session, SessionError, NAV_MARK, WAIT_POLL, WAIT_TIMEOUT};
use crate::browser::verbs::{self, Verb};

/// How long an evaluate waits for a navigating page's new JavaScript context,
/// and how often it asks. A navigation replaces the context in milliseconds;
/// the bound only stops a page that never finishes loading from hanging a verb.
const CONTEXT_SWAP_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);
const CONTEXT_SWAP_RETRY: std::time::Duration = std::time::Duration::from_millis(50);

/// Whether an evaluate failed because the context it named was just replaced.
pub(super) fn is_context_swap(error: &str) -> bool {
    error.contains("Cannot find context with specified id")
        || error.contains("Execution context was destroyed")
}

impl Session {
    /// Run one verb.
    pub async fn run(&mut self, verb: Verb) -> Result<Output, SessionError> {
        match verb {
            Verb::Help => Ok(Output::Text(verbs::HELP.to_string())),
            Verb::Goto { url } => self.goto(&url).await,
            Verb::Eval { expression } => {
                let value = self.eval(&expression).await?;
                Ok(Output::Line(render(&value)))
            }
            Verb::Click { selector } => self.click(&selector).await,
            Verb::Type { selector, text } => self.type_into(&selector, &text).await,
            Verb::Wait { selector } => self.wait_for(&selector).await,
            Verb::Title => {
                let value = self.eval("document.title").await?;
                Ok(Output::Line(render(&value)))
            }
            Verb::Url => {
                let value = self.eval("location.href").await?;
                Ok(Output::Line(render(&value)))
            }
            Verb::Text { selector } => self.text_of(selector.as_deref()).await,
            Verb::Back => {
                self.eval("history.back()").await?;
                Ok(Output::Silent)
            }
            Verb::Forward => {
                self.eval("history.forward()").await?;
                Ok(Output::Silent)
            }
            // The size is the pane's to choose: it decides where the picture
            // sits in the pane, which the engine does not know about.
            Verb::Viewport { .. } | Verb::Repl { .. } => Err(SessionError::Engine(
                "`viewport` is set in a browser pane, at its `:` prompt".into(),
            )),
            Verb::Reload => {
                self.page
                    .reload()
                    .await
                    .map_err(|e| SessionError::Engine(e.to_string()))?;
                Ok(Output::Silent)
            }
            Verb::Shot { path } => self.screenshot(path.as_deref()).await,
        }
    }

    /// Navigate, then report where it landed.
    ///
    /// The URL is echoed rather than staying silent because a redirect is the
    /// normal case, and "I asked for X and got Y" is the most useful thing to
    /// know after a navigation.
    async fn goto(&mut self, url: &str) -> Result<Output, SessionError> {
        match self.attachment {
            Attachment::Launched => {
                self.page
                    .goto(NavigateParams::new(url.to_string()))
                    .await
                    .map_err(|e| SessionError::Engine(e.to_string()))?;
            }
            // chromiumoxide's `Page::goto` waits on frame lifecycle events that
            // an already-open tab in an attached browser never delivers, while
            // JS `location.assign` is blocked by Chrome when navigating from
            // `about:blank` or `https:` to a `file://` URL. Sending raw CDP
            // `Page.navigate` via `execute` after marking the old document
            // avoids both.
            Attachment::Attached => {
                let _ = self.eval(&format!("window.{NAV_MARK} = true")).await;
                self.page
                    .execute(NavigateParams::new(url.to_string()))
                    .await
                    .map_err(|e| SessionError::Engine(e.to_string()))?;
            }
        }
        // Settling on `document.readyState` rather than a load event: the event
        // may have fired before this call got here, and a wait for an event
        // that already happened never returns. A same-document navigation (a
        // `#fragment`) keeps the document and its mark, and is done once the
        // address is the one asked for.
        let target = serde_json::to_string(url).map_err(|e| SessionError::Engine(e.to_string()))?;
        let settled = format!(
            "document.readyState !== 'loading' && (!window.{NAV_MARK} || location.href === {target})"
        );
        let deadline = std::time::Instant::now() + WAIT_TIMEOUT;
        while std::time::Instant::now() < deadline {
            // A document being swapped out can fail to answer; that is the
            // navigation still happening, not an error.
            if let Ok(value) = self.eval(&settled).await {
                if value.as_bool() == Some(true) {
                    break;
                }
            }
            tokio::time::sleep(WAIT_POLL).await;
        }
        let value = self.eval("location.href").await?;
        Ok(Output::Line(render(&value)))
    }

    /// Click the first match, through the page rather than at coordinates.
    ///
    /// `element.click()` is what a selector-shaped request means: it does not
    /// depend on the element being scrolled into view, on nothing overlapping
    /// it, or on the viewport size — all of which a coordinate click does, and
    /// all of which would make the verb fail for reasons the caller cannot see.
    /// Coordinate input is what the pane's own mouse forwarding is for.
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
    /// Assigning `.value` alone is invisible to React, Vue and anything else
    /// that tracks state from events rather than the DOM — the field shows the
    /// text and the app does not know it is there, which is the most confusing
    /// possible outcome.
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
    /// `innerText`, not `textContent`: the question is "what does this say", and
    /// `textContent` answers with `<script>` bodies and hidden elements too.
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

    async fn screenshot(&mut self, path: Option<&str>) -> Result<Output, SessionError> {
        let bytes = self
            .page
            .screenshot(
                CaptureScreenshotParams::builder()
                    .format(CaptureScreenshotFormat::Png)
                    .build(),
            )
            .await
            .map_err(|e| SessionError::Engine(e.to_string()))?;

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

    /// Evaluate an expression in the page and hand back its value.
    ///
    /// Right after a navigation the page's JavaScript context is torn down and
    /// a new one made; an evaluate that reaches the engine in between names the
    /// old context and fails with "Cannot find context with specified id". That
    /// is the page being replaced, not the page refusing, so it is retried
    /// until the new context is there (bounded by `CONTEXT_SWAP_TIMEOUT`).
    pub async fn eval(&mut self, expression: &str) -> Result<serde_json::Value, SessionError> {
        let deadline = tokio::time::Instant::now() + CONTEXT_SWAP_TIMEOUT;
        loop {
            match self.page.evaluate(expression).await {
                Ok(result) => return Ok(result.into_value().unwrap_or(serde_json::Value::Null)),
                Err(e) => {
                    let text = e.to_string();
                    if is_context_swap(&text) {
                        if tokio::time::Instant::now() >= deadline {
                            return Err(SessionError::PageReplaced);
                        }
                        tokio::time::sleep(CONTEXT_SWAP_RETRY).await;
                        continue;
                    }
                    // A page that threw is not a transport failure: the request
                    // succeeded and the answer is an exception. Reporting it as
                    // such is the difference between "ReferenceError: foo is not
                    // defined" and "the browser is gone".
                    return Err(if text.contains("Error") || text.contains("xception") {
                        SessionError::PageThrew(text)
                    } else {
                        SessionError::Engine(text)
                    });
                }
            }
        }
    }
}

/// A Rust string as a JavaScript string literal.
///
/// Every selector and every piece of text reaches the page inside an expression
/// this process builds, so this is the only thing between a selector containing
/// a quote and an expression that means something else. `serde_json` rather
/// than hand-rolled escaping: JSON string syntax is a subset of JavaScript's,
/// and it already handles quotes, backslashes, newlines and control characters.
pub(super) fn json_string(value: &str) -> String {
    serde_json::Value::String(value.to_string()).to_string()
}

/// A JSON value as a REPL would print it.
///
/// A string prints as itself rather than as `"itself"`: at a prompt, `title`
/// answering `My Page` is what someone wants, and the quotes are noise a script
/// then has to strip.
pub(super) fn render(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::Null => "null".to_string(),
        serde_json::Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}
