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

use tokio::sync::{watch, Mutex};

use super::discover;
use super::engine::profile_dir;
use super::process::{Channel, Engine, EngineError};
use super::verbs::{self, Verb};

/// How long a `wait` verb polls before giving up.
///
/// A deadline rather than a "settle" delay: `wait` exists because the caller
/// knows the thing has not happened yet, so the only honest answer is to keep
/// looking until it does or until this runs out.
const WAIT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);
/// How often `wait` re-asks. Cheap — one `Runtime.evaluate` per tick.
const WAIT_POLL: std::time::Duration = std::time::Duration::from_millis(100);

/// How the page is encoded for the pane.
///
/// JPEG rather than PNG: the pane is showing a live page, so each frame is
/// replaced within a tenth of a second and compression artefacts are invisible,
/// while a PNG of a photographic page is several times the bytes. Quality 70 is
/// where text stays crisp and the size stops falling much.
const FRAME_FORMAT: &str = "jpeg";
const FRAME_QUALITY: u32 = 70;

/// A cap on the frame's pixel size, independent of the viewport.
///
/// The viewport is what the PAGE lays out against and follows the pane; this is
/// only how many pixels get encoded and sent. A retina pane asking for its full
/// device resolution would triple the bytes for detail the pane cannot show
/// after scaling, so the frame is capped and the `<img>` scales it.
const FRAME_MAX_WIDTH: u32 = 1920;
const FRAME_MAX_HEIGHT: u32 = 1200;

/// One encoded frame of the page.
pub type Frame = Arc<Vec<u8>>;

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
    #[error("a {width}x{height} viewport is not usable")]
    BadViewport { width: u32, height: u32 },
    #[error("`{method}` is not an input event a pane may forward")]
    NotForwardable { method: String },
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
    /// The latest frame of the page, for anyone streaming it.
    ///
    /// A `watch` rather than a broadcast queue, because this is video: a client
    /// that falls behind should see the CURRENT frame, not work through a
    /// backlog of stale ones. `watch` keeps only the latest and drops the rest,
    /// which is exactly that policy, and it cannot lag-error the way a
    /// broadcast receiver can.
    frames: watch::Sender<Frame>,
    /// Whether `Page.startScreencast` has been sent.
    ///
    /// Started lazily, on the first client that asks to stream, so a session
    /// nobody is looking at encodes nothing. Chromium only emits a frame when
    /// the page changes visually, so an idle page then costs nothing either.
    screencasting: bool,
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
        let mut engine = Engine::launch(&browser, &profile).await?;

        // `Page` has to be enabled before its events arrive, and `Runtime`
        // before `Runtime.evaluate` reports exceptions properly. Both are
        // idempotent and cheap, so they happen at start rather than lazily per
        // verb — a verb that silently enables a domain is a verb whose first
        // call behaves differently from its second.
        engine.send("Page.enable", serde_json::json!({})).await?;
        engine.send("Runtime.enable", serde_json::json!({})).await?;

        // An empty first frame, so a client that connects before the page has
        // painted gets a well-formed stream rather than a stalled one. The
        // receiver is dropped immediately — every real one comes from
        // `subscribe()` — which is exactly why frames are published with
        // `send_replace` rather than `send`: see the pump.
        let (frames, _) = watch::channel(Arc::new(Vec::new()));

        // One pump for the engine's whole event stream. It owns the receiver,
        // so nothing else can take half the events, and it holds a `Channel`
        // rather than the session — acknowledging a frame must not wait on the
        // lock the verbs use.
        if let Some(events) = engine.take_events() {
            tokio::spawn(pump_events(engine.channel(), events, frames.clone()));
        }

        Ok(Self {
            engine,
            frames,
            screencasting: false,
            shots_dir: state_dir.join("browser-shots").join(name),
            profile,
        })
    }

    /// Subscribe to the page's frames, starting the screencast if this is the
    /// first subscriber.
    pub async fn watch_frames(&mut self) -> Result<watch::Receiver<Frame>, SessionError> {
        if !self.screencasting {
            self.engine
                .send(
                    "Page.startScreencast",
                    serde_json::json!({
                        "format": FRAME_FORMAT,
                        "quality": FRAME_QUALITY,
                        "maxWidth": FRAME_MAX_WIDTH,
                        "maxHeight": FRAME_MAX_HEIGHT,
                    }),
                )
                .await?;
            self.screencasting = true;

            // Chromium emits a screencast frame only when the page CHANGES
            // visually. A page someone has opened to read does not change, so
            // without this the stream carries nothing at all and the pane stays
            // blank until the user happens to make something move — which, for
            // an article or a dashboard, may be never.
            //
            // So the first frame is taken explicitly. `captureScreenshot` is
            // the on-demand form of the same picture; after it the screencast
            // supplies every subsequent one.
            if let Ok(shot) = self
                .engine
                .send(
                    "Page.captureScreenshot",
                    serde_json::json!({ "format": FRAME_FORMAT, "quality": FRAME_QUALITY }),
                )
                .await
            {
                if let Some(bytes) = shot
                    .get("data")
                    .and_then(serde_json::Value::as_str)
                    .and_then(base64_decode)
                {
                    if !bytes.is_empty() {
                        self.frames.send_replace(Arc::new(bytes));
                    }
                }
            }
        }
        Ok(self.frames.subscribe())
    }

    /// Lay the page out for a pane of this many CSS pixels.
    ///
    /// The viewport is what the page's own media queries and layout see, so a
    /// narrow pane should get the narrow layout rather than a scaled-down wide
    /// one. `deviceScaleFactor` is the viewer's, so text is laid out at the
    /// density it will be shown at.
    ///
    /// Zero or absurd sizes are refused rather than clamped: a pane mid-resize
    /// momentarily reports 0, and a viewport of 0 makes Chromium stop painting
    /// altogether, which looks exactly like the feature being broken.
    pub async fn set_viewport(
        &mut self,
        width: u32,
        height: u32,
        scale: f64,
    ) -> Result<Output, SessionError> {
        if !(MIN_VIEWPORT..=MAX_VIEWPORT).contains(&width)
            || !(MIN_VIEWPORT..=MAX_VIEWPORT).contains(&height)
        {
            return Err(SessionError::BadViewport { width, height });
        }
        let scale = if (0.5..=4.0).contains(&scale) {
            scale
        } else {
            1.0
        };
        self.engine
            .send(
                "Emulation.setDeviceMetricsOverride",
                serde_json::json!({
                    "width": width,
                    "height": height,
                    "deviceScaleFactor": scale,
                    "mobile": false,
                }),
            )
            .await?;
        Ok(Output::Silent)
    }

    /// Forward one input event to the page.
    ///
    /// The params are passed through as the client built them, because they are
    /// CDP's own `Input.*` shapes and re-modelling them here would be a second
    /// schema to keep in step with the protocol. What this does add is the
    /// method allowlist: only the three `Input` methods the pane needs, so a
    /// client cannot reach the rest of CDP through this door.
    pub async fn forward_input(
        &mut self,
        method: &str,
        params: serde_json::Value,
    ) -> Result<Output, SessionError> {
        if !FORWARDABLE_INPUT.contains(&method) {
            return Err(SessionError::NotForwardable {
                method: method.to_string(),
            });
        }
        // Awaited, unlike the screencast ack. It is tempting not to — a
        // keystroke that waits for a round trip seems like it would type at the
        // speed of the network — but the caller is a `/commands` POST that is
        // already waiting for its HTTP response, so skipping the CDP reply
        // saves one write-and-read on a local pipe and nothing else. What it
        // would cost is every error: a dispatch that Chromium rejects comes
        // back as a reply nobody is waiting for and is dropped, which is how a
        // click that silently does nothing becomes impossible to debug. That
        // happened while building this, and it is why the reply is read.
        self.engine.send(method, params).await?;
        Ok(Output::Silent)
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

/// The `Input` methods a client may have forwarded to the page.
///
/// An allowlist rather than a prefix check: `Input` also carries
/// `setInterceptDrags` and the touch-emulation switches, and "anything starting
/// with Input." is the kind of rule that silently widens as the protocol grows.
const FORWARDABLE_INPUT: &[&str] = &[
    "Input.dispatchKeyEvent",
    "Input.dispatchMouseEvent",
    "Input.insertText",
];

/// Viewport bounds. The lower one matters: a pane mid-resize reports 0, and a
/// viewport of 0 makes Chromium stop painting, which looks like a broken
/// feature rather than a bad number.
const MIN_VIEWPORT: u32 = 16;
const MAX_VIEWPORT: u32 = 16384;

/// Read the engine's events forever: publish frames, acknowledge them, and
/// ignore the rest.
///
/// The acknowledgement is not optional. Chromium sends frames up to a small
/// outstanding limit and then stops until they are acked, so a pump that
/// publishes without acking shows the first few frames and then a still
/// picture — which looks like the page having stopped rather than the stream.
async fn pump_events(
    channel: Arc<Channel>,
    mut events: tokio::sync::mpsc::UnboundedReceiver<(String, serde_json::Value)>,
    frames: watch::Sender<Frame>,
) {
    while let Some((method, params)) = events.recv().await {
        if method != "Page.screencastFrame" {
            continue;
        }
        // Ack first, by session id, before any decoding: the sooner Chromium is
        // free to send the next frame the smoother the stream, and a frame that
        // fails to decode must not stall every frame after it.
        if let Some(ack) = params.get("sessionId").cloned() {
            if channel
                .fire(
                    "Page.screencastFrameAck",
                    serde_json::json!({ "sessionId": ack }),
                )
                .await
                .is_err()
            {
                // The engine is gone; so is the session.
                break;
            }
        }

        let Some(encoded) = params.get("data").and_then(serde_json::Value::as_str) else {
            continue;
        };
        match base64_decode(encoded) {
            Some(bytes) if !bytes.is_empty() => {
                // `send_replace`, not `send`. `send` FAILS when there are no
                // receivers and throws the value away with it — and a session
                // nobody is currently streaming is the normal case, not an
                // error. The frame still has to be kept, because the next
                // client to connect is handed the current value and nothing
                // else: dropping it meant a new viewer saw the empty initial
                // frame and then waited for the page to change, which for a
                // page someone is reading never happens. The pane stayed blank.
                frames.send_replace(Arc::new(bytes));
            }
            _ => tracing::debug!(
                target: "tmuxy_server::browser",
                "a screencast frame did not decode"
            ),
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

    /// The session called `name`, only if it is already running.
    ///
    /// Separate from `get_or_start` because a GET must not be able to launch a
    /// browser: the stream route is named by an `<img>` tag, and a reload of a
    /// stale page would otherwise resurrect a session the user closed.
    pub async fn existing(&self, name: &str) -> Option<Arc<Mutex<Session>>> {
        self.inner.lock().await.get(name).map(Arc::clone)
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
