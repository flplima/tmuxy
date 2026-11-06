/// The longest OSC 8 URL honoured. A longer one opens no link and its text
/// is drawn plain: the URL comes from the program's output, and a link the
/// size of the screen is not one anybody follows.
pub const MAX_HYPERLINK_URL_BYTES: usize = 8 * 1024;

/// How many links a screen remembers, as tmux's own `MAX_HYPERLINKS`: past
/// it the oldest is forgotten, and the cells still written under it lose it.
pub const MAX_HYPERLINKS: usize = 5000;

/// The most URL bytes a screen holds at once, so the cap above cannot mean
/// 5000 URLs of the longest kind. Past it, too, the oldest link goes.
pub const MAX_HYPERLINK_BYTES: usize = 1024 * 1024;

/// The URLs of the OSC 8 links a screen's cells were written under, by the
/// id each cell carries (`Attrs::link`).
///
/// Ids only grow, so a forgotten id is never handed out again and a cell
/// that outlived its link resolves to nothing rather than to somebody
/// else's URL.
#[derive(Clone, Debug, Default)]
pub struct Hyperlinks {
    /// Oldest first, so the ids ascend.
    links: std::collections::VecDeque<(u32, Box<str>)>,
    bytes: usize,
    last_id: u32,
}

impl Hyperlinks {
    /// The id to write text under for an OSC 8 that opened `url`, or
    /// [`LinkId::NONE`](crate::attrs::LinkId::NONE) when it opens no link.
    pub fn open(&mut self, url: &[u8]) -> crate::attrs::LinkId {
        if url.is_empty() || url.len() > MAX_HYPERLINK_URL_BYTES {
            return crate::attrs::LinkId::NONE;
        }
        let url = String::from_utf8_lossy(url);
        // An application that repaints in place opens the same link on
        // every frame.
        if let Some((id, last)) = self.links.back() {
            if **last == *url {
                return crate::attrs::LinkId::new(*id);
            }
        }
        let Some(id) = self.last_id.checked_add(1) else {
            return crate::attrs::LinkId::NONE;
        };
        self.last_id = id;
        self.bytes += url.len();
        self.links.push_back((id, url.into()));
        while self.links.len() > MAX_HYPERLINKS || self.bytes > MAX_HYPERLINK_BYTES {
            if let Some((_, gone)) = self.links.pop_front() {
                self.bytes -= gone.len();
            }
        }
        crate::attrs::LinkId::new(id)
    }

    /// The URL `id` was opened with, if it is still remembered.
    pub fn get(&self, id: crate::attrs::LinkId) -> Option<&str> {
        let id = id.get()?;
        let at = self.links.binary_search_by_key(&id, |(id, _)| *id).ok()?;
        self.links.get(at).map(|(_, url)| &**url)
    }
}

