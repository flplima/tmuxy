//! The files a `preview` widget shows, and the only ones it may read.
//!
//! `tmuxy open <file>` turns a pane into a preview of one local HTML or
//! markdown file. The client renders it — markdown in the app, a page in a
//! sandboxed frame — but the bytes come from here, through a client command,
//! and what may be read is decided by tmux, not by the client:
//!
//! - **The document** is the file named by the pane's `@tmuxy-pane-preview`,
//!   honoured only while `@tmuxy-pane-widget` is `preview`. `tmuxy-widget-preview`
//!   writes both out of band through `run-shell` and clears them on exit, so
//!   nothing a pane prints and nothing a client sends can point a preview at
//!   another file. The client names the pane; the path is tmux's answer.
//! - **A resource** — a stylesheet, script, image or font the document links —
//!   is a path relative to the document's directory, and it must stay inside
//!   that directory once symlinks are resolved, may not pass through a hidden
//!   name (`.ssh`, `.env`, `..`), and must be one of the types a page loads.
//!   A downloaded page cannot reach `~/.aws/credentials` by linking it as a
//!   stylesheet.
//!
//! Every read is a regular file under a size cap, done off the async workers.

use std::path::{Component, Path, PathBuf};

use base64::Engine as _;

use crate::constants::tmux_options::{PANE_PREVIEW, PANE_PREVIEW_NET, PANE_WIDGET};
use crate::control_mode::MonitorCommandSender;
use crate::mime::content_type_for_path;
use crate::transport::query;
use crate::{CommandError, PaneId};

/// The largest document a preview reads.
pub const MAX_DOCUMENT_BYTES: u64 = 8 * 1024 * 1024;
/// The largest single resource a document may link.
pub const MAX_RESOURCE_BYTES: u64 = 16 * 1024 * 1024;
/// The largest composed page a client may stage for a pane's frame.
pub const MAX_STAGED_BYTES: usize = 48 * 1024 * 1024;
/// How many panes' staged pages are kept; the oldest goes first.
const STAGED_PAGES: usize = 16;

/// The widget name the authorisation must carry.
const WIDGET: &str = "preview";

/// What tmux says a pane may preview.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Authorisation {
    /// The document, as `tmuxy-widget-preview` resolved it (absolute).
    pub document: PathBuf,
    /// Whether the user opened it with `--net`: its page may load from the
    /// network. Off, the frame is offline.
    pub net: bool,
}

/// The two kinds of document a preview renders.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DocumentKind {
    Html,
    Markdown,
}

impl DocumentKind {
    pub fn of(path: &Path) -> Option<Self> {
        match extension(path).as_deref() {
            Some("html" | "htm") => Some(Self::Html),
            Some("md" | "markdown") => Some(Self::Markdown),
            _ => None,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Html => "html",
            Self::Markdown => "markdown",
        }
    }
}

/// The resource types a document may link: what a page loads to draw itself.
/// Nothing that is merely a file (`.txt`, `.json`, `.pdf`, a key).
const RESOURCE_EXTENSIONS: &[&str] = &[
    "css", "js", "mjs", "png", "jpg", "jpeg", "gif", "webp", "avif", "svg", "ico", "bmp", "woff",
    "woff2", "ttf", "otf",
];

fn extension(path: &Path) -> Option<String> {
    path.extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
}

/// Parse tmux's answer to [`authorisation_query`]: the widget tag, the path
/// and the network flag, one per line.
pub fn parse_authorisation(answer: &str) -> Result<Authorisation, CommandError> {
    let mut lines = answer.lines();
    let widget = lines.next().unwrap_or("").trim();
    let document = lines.next().unwrap_or("").trim();
    let net = lines.next().unwrap_or("").trim() == "1";
    if widget != WIDGET || document.is_empty() {
        return Err(CommandError::forbidden(
            "this pane is not showing a preview",
        ));
    }
    let document = PathBuf::from(document);
    if !document.is_absolute() {
        return Err(CommandError::forbidden(
            "the preview's path is not absolute",
        ));
    }
    Ok(Authorisation { document, net })
}

/// The in-band query whose answer [`parse_authorisation`] reads. The pane id's
/// type makes it safe in a command line.
fn authorisation_query(pane: &PaneId) -> String {
    [PANE_WIDGET, PANE_PREVIEW, PANE_PREVIEW_NET]
        .map(|option| format!("display-message -p -t {pane} '#{{{option}}}'"))
        .join(" ; ")
}

/// Ask tmux what `pane` may preview.
pub async fn authorisation(
    tx: &MonitorCommandSender,
    pane: &PaneId,
) -> Result<Authorisation, CommandError> {
    let answer = query(tx, &authorisation_query(pane))
        .await
        .map_err(|e| e.context("Failed to read the pane's preview"))?;
    parse_authorisation(&answer)
}

/// A regular file's bytes, refused before the read when it is anything else
/// (a symlink, a FIFO that would block, `/dev/zero` that never ends) or larger
/// than `cap`. Checked on the path before the open, because opening a device
/// can act on it (a terminal becomes the server's controlling one, a watchdog
/// starts), and again on the descriptor, so a path swapped in between is
/// caught before the read.
fn read_capped(path: &Path, cap: u64) -> Result<Vec<u8>, CommandError> {
    use std::io::Read;

    let failed = |e: std::io::Error| CommandError::invalid(format!("{}: {e}", path.display()));
    let check = |meta: std::fs::Metadata| {
        if !meta.is_file() {
            return Err(CommandError::invalid(format!(
                "{} is not a regular file",
                path.display()
            )));
        }
        if meta.len() > cap {
            return Err(CommandError::invalid(format!(
                "{} is larger than {cap} bytes",
                path.display()
            )));
        }
        Ok(meta.len())
    };

    check(std::fs::symlink_metadata(path).map_err(failed)?)?;
    let mut opts = std::fs::OpenOptions::new();
    opts.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_NOCTTY);
    }
    let file = opts.open(path).map_err(failed)?;
    let len = check(file.metadata().map_err(failed)?)?;
    let mut bytes = Vec::with_capacity(len as usize);
    file.take(cap + 1).read_to_end(&mut bytes).map_err(failed)?;
    if bytes.len() as u64 > cap {
        return Err(CommandError::invalid(format!(
            "{} is larger than {cap} bytes",
            path.display()
        )));
    }
    Ok(bytes)
}

/// Resolve and validate the previewed document itself: it must carry an `.html`
/// or `.md` extension, must not be a symlink, and must still carry that same
/// kind once canonicalized.
fn resolve_document(document: &Path) -> Result<(PathBuf, DocumentKind), CommandError> {
    let kind = DocumentKind::of(document).ok_or_else(|| {
        CommandError::forbidden("a preview shows an .html or .md file, nothing else")
    })?;
    let meta = std::fs::symlink_metadata(document)
        .map_err(|e| CommandError::invalid(format!("{}: {e}", document.display())))?;
    if meta.file_type().is_symlink() {
        return Err(CommandError::forbidden("a symlink cannot be previewed"));
    }
    let resolved = document
        .canonicalize()
        .map_err(|e| CommandError::invalid(format!("{}: {e}", document.display())))?;
    if DocumentKind::of(&resolved) != Some(kind) {
        return Err(CommandError::forbidden(
            "a preview shows an .html or .md file, nothing else",
        ));
    }
    Ok((resolved, kind))
}

/// Whether a path component is one a resource may pass through: not hidden,
/// not `..`, not the root.
fn plain_component(component: Component<'_>) -> bool {
    match component {
        Component::Normal(name) => !name.to_string_lossy().starts_with('.'),
        Component::CurDir => true,
        _ => false,
    }
}

/// Where a resource `relative` to `document` lives, or why it may not be read.
///
/// Checked twice: as written (no absolute path, no `..`, no hidden name, an
/// allowed type) and again once every symlink is resolved, since a link inside
/// the directory can point anywhere — out of it, or at a hidden file in it.
pub fn resolve_resource(document: &Path, relative: &str) -> Result<PathBuf, CommandError> {
    let refuse = |why: &str| CommandError::forbidden(format!("{relative}: {why}"));
    if relative.is_empty() || relative.contains('\0') || relative.contains('\\') {
        return Err(refuse("not a relative path"));
    }
    let written = Path::new(relative);
    if written.is_absolute() || !written.components().all(plain_component) {
        return Err(refuse("outside the document's folder, or hidden"));
    }
    match extension(written) {
        Some(ext) if RESOURCE_EXTENSIONS.contains(&ext.as_str()) => {}
        _ => return Err(refuse("not a type a page loads")),
    }

    let folder = document
        .parent()
        .ok_or_else(|| refuse("the document has no folder"))?;
    let folder = folder
        .canonicalize()
        .map_err(|e| CommandError::invalid(format!("{}: {e}", folder.display())))?;
    let resolved = folder
        .join(written)
        .canonicalize()
        .map_err(|e| CommandError::invalid(format!("{relative}: {e}")))?;
    let inside = resolved
        .strip_prefix(&folder)
        .map_err(|_| refuse("outside the document's folder"))?;
    if inside.as_os_str().is_empty() || !inside.components().all(plain_component) {
        return Err(refuse("outside the document's folder, or hidden"));
    }
    match extension(&resolved) {
        Some(ext) if RESOURCE_EXTENSIONS.contains(&ext.as_str()) => Ok(resolved),
        _ => Err(refuse("not a type a page loads")),
    }
}

/// The document itself: `{ kind, name, text, net }`.
pub fn read_document(auth: &Authorisation) -> Result<serde_json::Value, CommandError> {
    let (resolved, kind) = resolve_document(&auth.document)?;
    let bytes = read_capped(&resolved, MAX_DOCUMENT_BYTES)?;
    let name = auth
        .document
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    Ok(serde_json::json!({
        "kind": kind.as_str(),
        "name": name,
        "text": String::from_utf8_lossy(&bytes),
        "net": auth.net,
    }))
}

/// A resource the document links: `{ mime, data }`, the bytes in base64.
pub fn read_resource(
    auth: &Authorisation,
    relative: &str,
) -> Result<serde_json::Value, CommandError> {
    let (resolved_doc, _) = resolve_document(&auth.document)?;
    let path = resolve_resource(&resolved_doc, relative)?;
    let bytes = read_capped(&path, MAX_RESOURCE_BYTES)?;
    Ok(serde_json::json!({
        "mime": content_type_for_path(&path.to_string_lossy()),
        "data": base64::engine::general_purpose::STANDARD.encode(bytes),
    }))
}

/// `read_preview`, as both transports answer it: the document when `path` is
/// absent, the resource it names otherwise. Authorised by tmux on every call.
pub async fn read_preview(
    tx: &MonitorCommandSender,
    pane: &PaneId,
    path: Option<String>,
) -> Result<serde_json::Value, CommandError> {
    let auth = authorisation(tx, pane).await?;
    tokio::task::spawn_blocking(move || match path {
        None => read_document(&auth),
        Some(relative) => read_resource(&auth, &relative),
    })
    .await
    .map_err(|e| CommandError::unavailable(format!("preview read task failed: {e}")))?
}

/// Stage `html` as `pane`'s page, as both transports do it: only for a pane
/// tmux says is previewing an HTML document, and with that preview's network
/// permission, never one the client claims.
pub async fn stage_page(
    tx: &MonitorCommandSender,
    pages: &PreviewPages,
    pane: PaneId,
    html: String,
) -> Result<(), CommandError> {
    let auth = authorisation(tx, &pane).await?;
    let (_, kind) = tokio::task::spawn_blocking({
        let doc = auth.document.clone();
        move || resolve_document(&doc)
    })
    .await
    .map_err(|e| CommandError::unavailable(format!("preview check task failed: {e}")))??;
    if kind != DocumentKind::Html {
        return Err(CommandError::forbidden("this pane's preview is not a page"));
    }
    pages.stage(pane, html, auth.net)
}

/// The headers a staged page is served with, wherever it is served from.
///
/// `sandbox allow-scripts` without `allow-same-origin` gives the page an opaque
/// origin of its own: it never runs as the app, whichever URL loads it. The
/// rest is the offline policy — the page's own inline code and the `data:`
/// resources the client inlined into it, nothing fetched — or, opened with
/// `--net`, the network as well.
pub fn page_csp(net: bool) -> String {
    let remote = if net { " https: http:" } else { "" };
    let connect = if net {
        "https: http: wss: ws:"
    } else {
        "'none'"
    };
    format!(
        "sandbox allow-scripts; default-src 'none'; \
         script-src 'unsafe-inline' 'unsafe-eval' data:{remote}; \
         style-src 'unsafe-inline' data:{remote}; img-src data: blob:{remote}; \
         font-src data:{remote}; media-src data: blob:{remote}; connect-src {connect}; \
         frame-src{frames}; form-action 'none'; base-uri 'none'",
        frames = if net { " https: http:" } else { " 'none'" },
    )
}

/// One page per pane, composed by the client and served to the pane's frame.
///
/// The client builds the page (resources inlined, the theme and the bridge
/// added) because only it has the HTML parser and the theme; it is staged here
/// so the frame can load it from a URL that carries [`page_csp`] as a response
/// header. A `srcdoc` frame would inherit the app's own policy instead — the
/// desktop app forbids inline script, so neither the page nor the bridge would
/// run — and a header is the stronger place for a policy anyway: a meta tag
/// is the document's to precede.
#[derive(Debug, Default)]
struct PreviewStore {
    pages: std::collections::VecDeque<(PaneId, StagedPage)>,
    live_by_scope: std::collections::HashMap<String, std::collections::HashSet<PaneId>>,
}

#[derive(Debug, Default)]
pub struct PreviewPages {
    store: std::sync::Mutex<PreviewStore>,
}

/// A staged page and the policy it is served under.
#[derive(Debug, Clone)]
pub struct StagedPage {
    pub html: String,
    pub csp: String,
}

impl StagedPage {
    /// The response headers the page is served with, by the web route and
    /// the desktop scheme alike. `credentialless` and
    /// `Cross-Origin-Resource-Policy` let a cross-origin isolated app (the Vite
    /// dev server) embed the frame at all; elsewhere they change nothing.
    pub fn headers(&self) -> [(&'static str, String); 7] {
        [
            ("Content-Type", "text/html; charset=utf-8".to_string()),
            ("Content-Security-Policy", self.csp.clone()),
            ("Cache-Control", "no-store".to_string()),
            ("X-Content-Type-Options", "nosniff".to_string()),
            ("Referrer-Policy", "no-referrer".to_string()),
            ("Cross-Origin-Embedder-Policy", "credentialless".to_string()),
            ("Cross-Origin-Resource-Policy", "cross-origin".to_string()),
        ]
    }
}

impl PreviewPages {
    /// Replace `pane`'s page. Refused over [`MAX_STAGED_BYTES`].
    pub fn stage(&self, pane: PaneId, html: String, net: bool) -> Result<(), CommandError> {
        if html.len() > MAX_STAGED_BYTES {
            return Err(CommandError::invalid(format!(
                "a staged page is limited to {MAX_STAGED_BYTES} bytes"
            )));
        }
        let page = StagedPage {
            html,
            csp: page_csp(net),
        };
        let mut store = self.store.lock().unwrap_or_else(|e| e.into_inner());
        store.pages.retain(|(id, _)| *id != pane);
        if store.pages.len() >= STAGED_PAGES {
            store.pages.pop_front();
        }
        store.pages.push_back((pane, page));
        Ok(())
    }

    /// `pane`'s page, if one is staged.
    pub fn page(&self, pane: &PaneId) -> Option<StagedPage> {
        let store = self.store.lock().unwrap_or_else(|e| e.into_inner());
        store
            .pages
            .iter()
            .find(|(id, _)| id == pane)
            .map(|(_, page)| page.clone())
    }

    /// Drop `pane`'s staged page.
    pub fn evict(&self, pane: &PaneId) {
        let mut store = self.store.lock().unwrap_or_else(|e| e.into_inner());
        store.pages.retain(|(id, _)| id != pane);
    }

    /// Evict staged pages for panes in `scope` (a session name or GUI window
    /// label) whose `@tmuxy-pane-widget` left `preview` or whose pane closed.
    pub fn sync_update(&self, scope: &str, update: &crate::StateUpdate) {
        match update {
            crate::StateUpdate::Full { state } => {
                let live: std::collections::HashSet<PaneId> =
                    state.panes.iter().map(|p| p.tmux_id.clone()).collect();
                let non_preview: std::collections::HashSet<PaneId> = state
                    .panes
                    .iter()
                    .filter(|p| p.pane_widget.as_deref() != Some(WIDGET))
                    .map(|p| p.tmux_id.clone())
                    .collect();
                let mut store = self.store.lock().unwrap_or_else(|e| e.into_inner());
                let prev = store.live_by_scope.insert(scope.to_string(), live.clone());
                store.pages.retain(|(id, _)| {
                    if non_preview.contains(id) {
                        return false;
                    }
                    if let Some(ref prev_live) = prev {
                        if prev_live.contains(id) && !live.contains(id) {
                            return false;
                        }
                    }
                    true
                });
            }
            crate::StateUpdate::Delta { delta } => {
                let mut store = self.store.lock().unwrap_or_else(|e| e.into_inner());
                if let Some(new_panes) = &delta.new_panes {
                    for pane in new_panes {
                        store
                            .live_by_scope
                            .entry(scope.to_string())
                            .or_default()
                            .insert(pane.tmux_id.clone());
                        if pane.pane_widget.as_deref() != Some(WIDGET) {
                            store.pages.retain(|(id, _)| *id != pane.tmux_id);
                        }
                    }
                }
                if let Some(panes) = &delta.panes {
                    for (pane_id, change) in panes {
                        match change {
                            None => {
                                if let Some(live) = store.live_by_scope.get_mut(scope) {
                                    live.remove(pane_id);
                                }
                                store.pages.retain(|(id, _)| id != pane_id);
                            }
                            Some(pane_delta) => {
                                if let Some(ref widget) = pane_delta.pane_widget {
                                    if widget.as_deref() != Some(WIDGET) {
                                        store.pages.retain(|(id, _)| id != pane_id);
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests;
