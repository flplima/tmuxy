//! One browser session: an engine, a page, and the verbs run against it.
//!
//! A session is owned by whoever started it — the pane program for a browser
//! pane, or a one-shot CLI invocation — and lives exactly as long as that
//! owner. There is no registry and no sharing: what made a registry necessary
//! was a widget streaming frames over HTTP, and the pane now draws its own
//! frames into its own terminal (`pane.rs`).

use std::path::{Path, PathBuf};
use std::sync::Arc;

use chromiumoxide::browser::Browser;
use chromiumoxide::cdp::browser_protocol::emulation::SetDeviceMetricsOverrideParams;
use chromiumoxide::cdp::browser_protocol::page::{
    CaptureScreenshotFormat, CaptureScreenshotParams, EventScreencastFrame, NavigateParams,
    ScreencastFrameAckParams, StartScreencastFormat, StartScreencastParams, StopScreencastParams,
};
use chromiumoxide::page::Page;
use futures_util::StreamExt;
use tokio::sync::watch;

use super::discover;
use super::engine::{engine_config, profile_dir};
use super::verbs::{self, Verb};

/// How long a `wait` verb polls before giving up.
const WAIT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);
/// How often `wait` re-asks. Cheap — one evaluate per tick.
const WAIT_POLL: std::time::Duration = std::time::Duration::from_millis(100);

/// How the page is encoded for the pane.
///
/// JPEG rather than PNG: a frame is replaced within a tenth of a second and
/// compression artefacts are invisible, while a PNG of a photographic page is
/// several times the bytes — and these bytes travel through the SAME control
/// mode stream as keystroke echo, so size here is latency there.
/// How long to wait for a closing browser to actually be gone.
const SHUTDOWN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

const FRAME_QUALITY: i64 = 60;
/// A cap on the encoded frame, independent of the viewport.
///
/// The viewport is what the page LAYS OUT against and follows the pane; this is
/// only how many pixels get encoded. A retina pane asking for its full device
/// resolution would multiply the bytes for detail a pane cannot show.
const FRAME_MAX_WIDTH: i64 = 1600;
const FRAME_MAX_HEIGHT: i64 = 1000;
/// The shortest gap between two published frames: five a second.
///
/// A pane cannot show more, a terminal stream cannot afford more, and this is a
/// picture of a page rather than video. See the pump in `start_frames` for why
/// this is a time budget and not `everyNthFrame`.
const FRAME_MIN_INTERVAL: std::time::Duration = std::time::Duration::from_millis(200);

/// Send every Nth frame.
///
/// One, which is to say no throttle, and the reason is worth stating because
/// the obvious value is wrong. `everyNthFrame` counts COMPOSITOR frames, not
/// time: a page being scrolled produces hundreds and a still page produces one
/// or two. At 4, the still page's one-or-two are all dropped — so a `:goto` to
/// an ordinary static page left the PREVIOUS page's picture on screen forever,
/// while a page that animated looked perfect. The throttle silently deleted
/// exactly the frames that matter most.
///
/// The budget is kept by the other two knobs instead, which cost bytes rather
/// than correctness: quality, and the encoded-size cap. A still page costs
/// nothing either way, because it produces no frames to send.
const FRAME_EVERY_NTH: i64 = 1;

/// One encoded frame of the page.
pub type Frame = Arc<Vec<u8>>;

/// What a verb produced, as the pane and the CLI print it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Output {
    /// Nothing to say. Printing "ok" after every click would bury the output
    /// that matters.
    Silent,
    Line(String),
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
    #[error("could not start the browser: {0}")]
    Launch(String),
    #[error("the browser is gone: {0}")]
    Engine(String),
    #[error("no element matches `{selector}`")]
    NoSuchElement { selector: String },
    #[error("`{selector}` did not appear within {}s", WAIT_TIMEOUT.as_secs())]
    WaitedTooLong { selector: String },
    #[error("the page refused to evaluate that: {0}")]
    PageThrew(String),
    #[error("the page is still loading; try again")]
    PageReplaced,
    #[error("a {width}x{height} viewport is not usable")]
    BadViewport { width: u32, height: u32 },
    #[error("could not write {path}: {source}")]
    Write {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
}

/// How long an evaluate waits for a navigating page's new JavaScript context,
/// and how often it asks. A navigation replaces the context in milliseconds;
/// the bound only stops a page that never finishes loading from hanging a verb.
const CONTEXT_SWAP_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);
const CONTEXT_SWAP_RETRY: std::time::Duration = std::time::Duration::from_millis(50);

/// Whether an evaluate failed because the context it named was just replaced.
fn is_context_swap(error: &str) -> bool {
    error.contains("Cannot find context with specified id")
        || error.contains("Execution context was destroyed")
}

/// Viewport bounds. The lower one matters: a pane mid-resize reports 0, and a
/// viewport of 0 makes Chromium stop painting, which looks like a broken
/// feature rather than a bad number.
const MIN_VIEWPORT: u32 = 16;
const MAX_VIEWPORT: u32 = 16384;

/// How a session got its engine.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Attachment {
    /// A headless engine of our own, on a throwaway profile.
    Launched,
    /// The user's already-running browser. Their window is the view, so the
    /// pane draws no frames.
    Attached,
}

/// One browser session.
pub struct Session {
    browser: Browser,
    page: Page,
    attachment: Attachment,
    /// The latest frame of the page, for the pane to draw.
    ///
    /// A `watch` rather than a queue because this is video: a drawer that falls
    /// behind should paint the CURRENT frame, not work through stale ones.
    frames: watch::Sender<Frame>,
    screencasting: bool,
    shots_dir: PathBuf,
    profile: Option<PathBuf>,
    /// Kept so the connection's event loop is cancelled when the session drops.
    _handler: tokio::task::JoinHandle<()>,
}

impl Session {
    /// Launch a headless engine of our own.
    pub async fn launch(state_dir: &Path, name: &str) -> Result<Self, SessionError> {
        let browser_path = discover::find_browser()?;
        let profile = profile_dir(state_dir, name);
        std::fs::create_dir_all(&profile).map_err(|e| SessionError::Launch(e.to_string()))?;
        let config = engine_config(&browser_path, &profile).map_err(SessionError::Launch)?;
        let (browser, handler) = Browser::launch(config)
            .await
            .map_err(|e| SessionError::Launch(e.to_string()))?;
        Self::from_browser(
            browser,
            handler,
            state_dir,
            name,
            Attachment::Launched,
            Some(profile),
        )
        .await
    }

    /// Attach to a browser the user is already running.
    ///
    /// `endpoint` is its DevTools address — `http://127.0.0.1:PORT` or a `ws://`
    /// URL. Chrome 136+ refuses remote debugging on the default profile, so a
    /// browser reachable here was either started with a non-default
    /// `--user-data-dir` or had debugging enabled through
    /// `chrome://inspect/#remote-debugging` (Chrome 144+), which asks the user
    /// first. Neither is something tmuxy can arrange on their behalf, which is
    /// why the help text explains both rather than this trying to guess.
    pub async fn attach(
        state_dir: &Path,
        name: &str,
        endpoint: &str,
    ) -> Result<Self, SessionError> {
        let (browser, handler) = Browser::connect(endpoint.to_string())
            .await
            .map_err(|e| SessionError::Launch(format!("could not attach to {endpoint}: {e}")))?;
        // No profile recorded: this one is the USER's, and removing it on exit
        // would delete their browsing data.
        Self::from_browser(
            browser,
            handler,
            state_dir,
            name,
            Attachment::Attached,
            None,
        )
        .await
    }

    async fn from_browser(
        browser: Browser,
        mut handler: chromiumoxide::handler::Handler,
        state_dir: &Path,
        name: &str,
        attachment: Attachment,
        profile: Option<PathBuf>,
    ) -> Result<Self, SessionError> {
        // chromiumoxide's handler IS the connection's event loop: nothing is
        // sent or received unless something is polling it.
        let handler_task = tokio::spawn(async move { while handler.next().await.is_some() {} });

        // Reuse the page the browser already has rather than opening a second
        // tab — a pane shows one page, and an attached browser's existing tab is
        // the one the user is looking at.
        let page = match browser.pages().await {
            Ok(pages) => match pages.into_iter().next() {
                Some(page) => page,
                None => browser
                    .new_page("about:blank")
                    .await
                    .map_err(|e| SessionError::Launch(e.to_string()))?,
            },
            Err(e) => return Err(SessionError::Launch(e.to_string())),
        };

        let (frames, _) = watch::channel(Arc::new(Vec::new()));

        Ok(Self {
            browser,
            page,
            attachment,
            frames,
            screencasting: false,
            shots_dir: state_dir.join("browser-shots").join(name),
            profile,
            _handler: handler_task,
        })
    }

    pub fn attachment(&self) -> Attachment {
        self.attachment
    }

    /// The page, for a caller that needs a CDP command this module does not wrap
    /// — the pane's input forwarding, which speaks `Input.*` directly.
    pub fn page(&self) -> &Page {
        &self.page
    }

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
        self.page
            .goto(NavigateParams::new(url.to_string()))
            .await
            .map_err(|e| SessionError::Engine(e.to_string()))?;
        // Settling on `document.readyState` rather than a load event: the event
        // may have fired before this call got here, and a wait for an event
        // that already happened never returns.
        let deadline = std::time::Instant::now() + WAIT_TIMEOUT;
        while std::time::Instant::now() < deadline {
            let state = self.eval("document.readyState").await?;
            if matches!(state.as_str(), Some("complete") | Some("interactive")) {
                break;
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

    /// Lay the page out for a pane of this many CSS pixels.
    ///
    /// Zero or absurd sizes are refused rather than clamped: a pane mid-resize
    /// momentarily reports 0, and a viewport of 0 makes Chromium stop painting
    /// altogether, which looks exactly like the feature being broken.
    pub async fn set_viewport(
        &mut self,
        width: u32,
        height: u32,
        scale: f64,
    ) -> Result<(), SessionError> {
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
        self.page
            .execute(SetDeviceMetricsOverrideParams::new(
                width as i64,
                height as i64,
                scale,
                false,
            ))
            .await
            .map_err(|e| SessionError::Engine(e.to_string()))?;
        Ok(())
    }

    /// Start the screencast and hand back a receiver of encoded frames.
    ///
    /// Two things make a page actually appear, and both were learned the hard
    /// way on the previous transport:
    ///
    /// * Chromium emits a frame only when the page CHANGES visually, so a page
    ///   someone is reading produces none at all. The first frame is therefore
    ///   captured explicitly.
    /// * Every frame must be acknowledged or Chromium stops after a small
    ///   allowance, which looks like the page having frozen rather than the
    ///   stream having stalled.
    pub async fn start_frames(&mut self) -> Result<watch::Receiver<Frame>, SessionError> {
        if self.screencasting {
            return Ok(self.frames.subscribe());
        }

        let mut events = self
            .page
            .event_listener::<EventScreencastFrame>()
            .await
            .map_err(|e| SessionError::Engine(e.to_string()))?;

        self.page
            .execute(
                StartScreencastParams::builder()
                    .format(StartScreencastFormat::Jpeg)
                    .quality(FRAME_QUALITY)
                    .max_width(FRAME_MAX_WIDTH)
                    .max_height(FRAME_MAX_HEIGHT)
                    .every_nth_frame(FRAME_EVERY_NTH)
                    .build(),
            )
            .await
            .map_err(|e| SessionError::Engine(e.to_string()))?;
        self.screencasting = true;

        let frames = self.frames.clone();
        let page = self.page.clone();
        tokio::spawn(async move {
            // Coalesce by TIME, keeping the newest.
            //
            // A page being scrolled repaints far faster than a pane can show,
            // and every frame is tens of kilobytes of base64 through control
            // mode. Measured before this existed: ~18 frames a second at ~43KB
            // each while scrolling an article, about 580 KB/s down a channel
            // that also carries every keystroke's echo (docs/PERFORMANCE.md).
            //
            // Coalescing rather than dropping is what keeps a STILL page
            // correct: the last frame of a burst is always published once the
            // page settles, so the picture ends up showing where the page
            // actually stopped — which the `everyNthFrame` throttle this
            // replaced could not do, since it threw whole frames away and a
            // still page only ever produces one.
            let mut pending: Option<Frame> = None;
            let mut last_sent = tokio::time::Instant::now() - FRAME_MIN_INTERVAL;
            loop {
                let due = last_sent + FRAME_MIN_INTERVAL;
                tokio::select! {
                    frame = events.next() => {
                        let Some(frame) = frame else { return };
                        // Ack first, before decoding: the sooner Chromium is
                        // free to send the next frame the smoother the stream,
                        // and a frame that fails to decode must not stall every
                        // frame after it.
                        let _ = page
                            .execute(ScreencastFrameAckParams::new(frame.session_id))
                            .await;
                        if let Some(bytes) = base64_decode(frame.data.as_ref()) {
                            if !bytes.is_empty() {
                                pending = Some(Arc::new(bytes));
                            }
                        }
                    }
                    // Nothing new while the budget ran out: whatever is pending
                    // is the current picture, so publish it.
                    _ = tokio::time::sleep_until(due), if pending.is_some() => {
                        if let Some(frame) = pending.take() {
                            // `send_replace`, not `send`: `send` FAILS when
                            // there is no receiver and throws the frame away
                            // with it, and the next drawer is handed the current
                            // value and nothing else.
                            frames.send_replace(frame);
                            last_sent = tokio::time::Instant::now();
                        }
                    }
                }
            }
        });

        // The explicit first frame, for a page that will never change.
        if let Ok(bytes) = self
            .page
            .screenshot(
                CaptureScreenshotParams::builder()
                    .format(CaptureScreenshotFormat::Jpeg)
                    .quality(FRAME_QUALITY)
                    .build(),
            )
            .await
        {
            if !bytes.is_empty() {
                self.frames.send_replace(Arc::new(bytes));
            }
        }

        Ok(self.frames.subscribe())
    }

    /// End the session.
    ///
    /// An ATTACHED browser is the user's and is left running — closing it would
    /// take their windows with it. A launched one is ours and goes, profile
    /// included: a throwaway profile that is not thrown away is a few hundred MB
    /// per session that nothing will reclaim.
    pub async fn close(&mut self) {
        if self.screencasting {
            let _ = self.page.execute(StopScreencastParams::default()).await;
        }
        if self.attachment == Attachment::Launched {
            let _ = self.browser.close().await;
            // Waited for, not just asked. `close` returns when Chromium has
            // ACCEPTED the request; it then flushes its profile on the way out,
            // and a profile removed before that happens is simply recreated —
            // leaving the throwaway directory on disk, which is the one thing
            // the word "throwaway" promises. Bounded, then killed: a wedged
            // browser must not hold the pane's exit open.
            if tokio::time::timeout(SHUTDOWN_TIMEOUT, self.browser.wait())
                .await
                .is_err()
            {
                let _ = self.browser.kill().await;
                let _ = tokio::time::timeout(SHUTDOWN_TIMEOUT, self.browser.wait()).await;
            }
            if let Some(profile) = &self.profile {
                if let Err(error) = std::fs::remove_dir_all(profile) {
                    if error.kind() != std::io::ErrorKind::NotFound {
                        tracing::warn!(
                            target: "tmuxy_server::browser",
                            profile = %profile.display(),
                            %error,
                            "could not remove the session profile"
                        );
                    }
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
fn json_string(value: &str) -> String {
    serde_json::Value::String(value.to_string()).to_string()
}

/// A JSON value as a REPL would print it.
///
/// A string prints as itself rather than as `"itself"`: at a prompt, `title`
/// answering `My Page` is what someone wants, and the quotes are noise a script
/// then has to strip.
fn render(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::Null => "null".to_string(),
        serde_json::Value::String(text) => text.clone(),
        other => other.to_string(),
    }
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

    /// The two ways Chromium says an evaluate named a context a navigation
    /// just replaced; anything else is the page's own answer or a real error.
    #[test]
    fn a_replaced_context_is_told_apart_from_a_page_error() {
        assert!(is_context_swap(
            "Error -32000: Cannot find context with specified id"
        ));
        assert!(is_context_swap(
            "Execution context was destroyed, most likely because of a navigation"
        ));
        assert!(!is_context_swap("ReferenceError: foo is not defined"));
        assert!(!is_context_swap("websocket closed"));
    }

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
        // the remainder would be trailing garbage and this parse would fail — a
        // substring check cannot tell `\"` from `"` and would pass either way.
        assert_eq!(
            serde_json::from_str::<String>(&escaped).expect("one valid JSON string"),
            hostile,
            "the page must receive the selector that was asked for"
        );

        let body = &escaped[1..escaped.len() - 1];
        let mut chars = body.chars().peekable();
        while let Some(c) = chars.next() {
            if c == '\\' {
                chars.next();
            } else {
                assert_ne!(c, '"', "an unescaped quote inside the literal: {escaped}");
            }
        }
    }

    #[test]
    fn a_string_result_prints_without_quotes() {
        assert_eq!(render(&serde_json::json!("My Page")), "My Page");
        assert_eq!(render(&serde_json::json!(42)), "42");
        assert_eq!(render(&serde_json::json!(true)), "true");
        assert_eq!(render(&serde_json::json!(null)), "null");
        assert_eq!(render(&serde_json::json!({ "a": 1 })), "{\"a\":1}");
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
    fn base64_round_trips_a_jpeg_header() {
        use base64::Engine as _;
        let jpeg = b"\xff\xd8\xff\xe0";
        let encoded = base64::engine::general_purpose::STANDARD.encode(jpeg);
        assert_eq!(base64_decode(&encoded).as_deref(), Some(&jpeg[..]));
        assert_eq!(base64_decode("not base64!!"), None);
    }

    /// The frame budget is a LATENCY budget: these bytes share the control-mode
    /// stream with keystroke echo (docs/PERFORMANCE.md, Axis C).
    #[test]
    fn the_frame_budget_stays_modest() {
        assert!(FRAME_QUALITY <= 70, "a higher quality is mostly more bytes");
        assert!(FRAME_MAX_WIDTH <= 1920 && FRAME_MAX_HEIGHT <= 1200);
        // Not a throttle. `everyNthFrame` counts compositor frames, so any
        // value above 1 drops the one-or-two frames a STILL page produces and
        // leaves the previous page on screen after a navigation. The budget is
        // kept with quality and the size cap instead.
        assert_eq!(
            FRAME_EVERY_NTH, 1,
            "throttling by frame count deletes a still page's only frames"
        );
    }
}
