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
use chromiumoxide::page::Page;
use futures_util::StreamExt;
use tokio::sync::watch;

use super::discover;
use super::engine::{engine_config, profile_dir};

mod screencast;
mod verbs_impl;

#[cfg(test)]
#[allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::assertions_on_constants
)]
mod tests;

/// How long a `wait` verb polls before giving up.
const WAIT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);
/// How often `wait` re-asks. Cheap — one evaluate per tick.
const WAIT_POLL: std::time::Duration = std::time::Duration::from_millis(100);

/// A property `goto` sets on the document it is leaving, so that it can tell
/// that document from the one it asked for.
const NAV_MARK: &str = "__tmuxyLeaving";

/// How long an attached browser's existing tab may take to become drivable.
const ATTACH_TAB_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

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
    /// How much larger than the page the window draws it (`set_viewport`):
    /// input lands in window pixels, so a click is scaled by it too.
    view_scale: f64,
    /// The page's own size in CSS pixels, as last set.
    page_size: (u32, u32),
    /// Whether that page is emulating a mobile device.
    mobile: bool,
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
        mut browser: Browser,
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
        let existing = match attachment {
            Attachment::Attached => existing_tab(&mut browser).await?,
            Attachment::Launched => browser
                .pages()
                .await
                .map_err(|e| SessionError::Launch(e.to_string()))?
                .into_iter()
                .next(),
        };
        let page = match existing {
            Some(page) => page,
            None => browser
                .new_page("about:blank")
                .await
                .map_err(|e| SessionError::Launch(e.to_string()))?,
        };

        let (frames, _) = watch::channel(Arc::new(Vec::new()));

        Ok(Self {
            browser,
            page,
            attachment,
            frames,
            screencasting: false,
            view_scale: 1.0,
            page_size: (0, 0),
            mobile: false,
            shots_dir: state_dir.join("browser-shots").join(name),
            profile,
            _handler: handler_task,
        })
    }

    /// Window pixels per page pixel (see `view_scale`).
    pub fn view_scale(&self) -> f64 {
        self.view_scale
    }

    pub fn attachment(&self) -> Attachment {
        self.attachment
    }

    /// The page, for a caller that needs a CDP command this module does not wrap
    /// — the pane's input forwarding, which speaks `Input.*` directly.
    pub fn page(&self) -> &Page {
        &self.page
    }
}

/// The tab an attached browser is already showing, once it can be driven.
///
/// A browser reached by `Browser::connect` reports no pages: chromiumoxide only
/// knows the targets it was told about, and the tabs that were open before it
/// connected were never announced. Asking for the targets attaches to them, and
/// a tab becomes a page when that attach is acknowledged — so it is polled for
/// rather than read once. Without this every `--attach` run opened a fresh
/// blank tab in the user's browser and drove that one instead.
async fn existing_tab(browser: &mut Browser) -> Result<Option<Page>, SessionError> {
    let targets = browser
        .fetch_targets()
        .await
        .map_err(|e| SessionError::Launch(e.to_string()))?;
    // Chrome lists the most recently used tab first.
    let Some(tab) = targets.into_iter().find(|t| is_user_tab(&t.r#type, &t.url)) else {
        return Ok(None);
    };
    let deadline = tokio::time::Instant::now() + ATTACH_TAB_TIMEOUT;
    loop {
        if let Ok(page) = browser.get_page(tab.target_id.clone()).await {
            return Ok(Some(page));
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(SessionError::Launch(format!(
                "the open tab ({}) never became drivable",
                tab.url
            )));
        }
        tokio::time::sleep(WAIT_POLL).await;
    }
}

/// A tab the user browses in, as opposed to DevTools, an extension's
/// background page or a service worker.
fn is_user_tab(kind: &str, url: &str) -> bool {
    kind == "page" && !url.starts_with("devtools://") && !url.starts_with("chrome-extension://")
}
