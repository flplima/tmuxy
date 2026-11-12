//! The diff's "last turn" scope: what an agent changed in a checkout between
//! the moment its pane turned `working` and the moment it stopped (or now,
//! while it works).
//!
//! A turn is two snapshots of the checkout's files, tracked and untracked
//! alike (what `.gitignore` leaves out stays out), each a tree written into a
//! store of tmuxy's own ([`git::Store`]): a private index and object
//! directory under tmuxy's state dir, the checkout's own objects read
//! through as alternates. Nothing is written into the checkout or its
//! repository, but for git's freshening: an object a snapshot finds already
//! there gets its modification time renewed, as any `git add` would, which
//! keeps a `gc` from pruning it. Turns are watched only for checkouts a diff widget shows
//! (`host::diff_turns`), kept in memory, and gone with the widget or the host.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;

use super::git;

/// The longest a snapshot is given: it hashes every file that changed.
const SNAPSHOT_LIMIT: Duration = Duration::from_secs(20);

/// A store not written for this long belongs to a host that is gone.
const STALE_STORE: Duration = Duration::from_secs(7 * 24 * 60 * 60);

/// One agent's turn in one checkout.
#[derive(Debug, Clone)]
struct Turn {
    agent: String,
    start: String,
    end: Option<String>,
}

/// The turn the scope shows, as the client is told it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnInfo {
    /// The agent's pane, `%N`.
    pub agent: String,
    /// The agent is still at it: the turn so far.
    pub ongoing: bool,
}

/// The last turn seen in each checkout, by its top folder.
static TURNS: Mutex<BTreeMap<PathBuf, Turn>> = Mutex::new(BTreeMap::new());

/// One snapshot at a time: they share each checkout's index.
static SNAPSHOTS: Mutex<()> = Mutex::new(());

fn turns() -> std::sync::MutexGuard<'static, BTreeMap<PathBuf, Turn>> {
    TURNS
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// This host's stores: one folder per process, so two hosts on one machine
/// never share an index.
fn host_dir() -> PathBuf {
    stores_dir().join(std::process::id().to_string())
}

/// Where every host's stores are: tmuxy's state dir.
static STORES: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();

fn stores_dir() -> &'static Path {
    STORES.get_or_init(|| crate::paths::state_dir().join("diff-turns"))
}

/// The stores in a folder of this test process's own, never the
/// developer's: the folder.
#[cfg(test)]
pub(crate) fn test_stores() -> PathBuf {
    let dir = std::env::temp_dir().join(format!("tmuxy-turn-stores-{}", std::process::id()));
    let _ = STORES.set(dir.clone());
    assert_eq!(stores_dir(), dir, "stores were already kept elsewhere");
    dir
}

/// A name for `root` that is a folder name, stable for this process.
fn store_name(root: &Path) -> String {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    root.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

/// The store `root`'s snapshots go to, made private to this user.
fn store_for(root: &Path, deadline: Instant) -> Option<git::Store> {
    let alternates = git::text(
        root,
        &[
            "rev-parse",
            "--path-format=absolute",
            "--git-path",
            "objects",
        ],
        deadline,
    )
    .map(|out| PathBuf::from(out.trim_end_matches('\n')))
    .filter(|dir| dir.is_absolute())?;
    let dir = host_dir().join(store_name(root));
    let objects = dir.join("objects");
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode_private()
        .create(&objects)
        .ok()?;
    Some(git::Store {
        index: dir.join("index"),
        objects,
        alternates,
    })
}

/// `create` folders readable by this user only.
trait Private {
    fn mode_private(&mut self) -> &mut Self;
}

impl Private for std::fs::DirBuilder {
    #[cfg(unix)]
    fn mode_private(&mut self) -> &mut Self {
        std::os::unix::fs::DirBuilderExt::mode(self, 0o700)
    }
    #[cfg(not(unix))]
    fn mode_private(&mut self) -> &mut Self {
        self
    }
}

/// The checkout's files as they are now, as a tree in `store`.
///
/// The store's index starts as a copy of the repository's, so files that
/// did not change are not read again. Should git not take that copy (a
/// split index keeps its entries in another file), it starts empty.
fn snapshot(root: &Path, store: &git::Store, deadline: Instant) -> Option<String> {
    let _one = SNAPSHOTS
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if !store.index.exists() {
        seed(root, store, deadline);
    }
    tree_now(root, store, deadline).or_else(|| {
        let _ = std::fs::remove_file(&store.index);
        tree_now(root, store, deadline)
    })
}

fn tree_now(root: &Path, store: &git::Store, deadline: Instant) -> Option<String> {
    // A file that cannot be read is left out, not a reason to fail.
    let _ = git::text_in(
        Some(store),
        root,
        &["add", "-A", "--ignore-errors"],
        deadline,
    );
    git::text_in(Some(store), root, &["write-tree"], deadline)
        .map(|out| out.trim().to_string())
        .filter(|tree| !tree.is_empty())
}

/// The repository's index, copied into `store` to start from.
fn seed(root: &Path, store: &git::Store, deadline: Instant) {
    let index = git::text(
        root,
        &["rev-parse", "--path-format=absolute", "--git-path", "index"],
        deadline,
    )
    .map(|out| PathBuf::from(out.trim_end_matches('\n')));
    if let Some(index) = index.filter(|path| path.is_absolute()) {
        let _ = std::fs::copy(index, &store.index);
    }
}

/// An agent in `root` started working: its turn starts from the files as
/// they are now, and the turn before it is forgotten.
pub fn begin(root: &Path, agent: &str) {
    let deadline = Instant::now() + SNAPSHOT_LIMIT;
    let Some(start) = store_for(root, deadline).and_then(|store| snapshot(root, &store, deadline))
    else {
        tracing::debug!(root = %root.display(), "no snapshot for a turn's start");
        return;
    };
    turns().insert(
        root.to_path_buf(),
        Turn {
            agent: agent.to_string(),
            start,
            end: None,
        },
    );
}

/// The agent stopped working: its turn ends with the files as they are now.
pub fn finish(root: &Path, agent: &str) {
    let ongoing = turns()
        .get(root)
        .is_some_and(|turn| turn.agent == agent && turn.end.is_none());
    if !ongoing {
        return;
    }
    let deadline = Instant::now() + SNAPSHOT_LIMIT;
    let Some(end) = store_for(root, deadline).and_then(|store| snapshot(root, &store, deadline))
    else {
        return;
    };
    if let Some(turn) = turns().get_mut(root).filter(|turn| turn.agent == agent) {
        turn.end = Some(end);
    }
}

/// Forget the turns and stores of every checkout no diff shows any more.
pub fn keep_only(shown: &[PathBuf]) {
    let gone: Vec<PathBuf> = turns()
        .keys()
        .filter(|root| !shown.contains(root))
        .cloned()
        .collect();
    for root in gone {
        forget(&root);
    }
}

/// Forget `root`'s turn and its store.
pub fn forget(root: &Path) {
    turns().remove(root);
    let _ = std::fs::remove_dir_all(host_dir().join(store_name(root)));
}

/// Remove the stores of hosts long gone (a host's own go with it, or with
/// its widgets).
pub fn prune_stale_stores() {
    let Ok(hosts) = std::fs::read_dir(stores_dir()) else {
        return;
    };
    let own = host_dir();
    for host in hosts.flatten() {
        let stale = host
            .metadata()
            .and_then(|meta| meta.modified())
            .ok()
            .and_then(|modified| modified.elapsed().ok())
            .is_some_and(|age| age > STALE_STORE);
        if stale && host.path() != own {
            let _ = std::fs::remove_dir_all(host.path());
        }
    }
}

/// The patch of `root`'s last turn: from its start to its end, or to now
/// while the agent works. An error when no turn was seen there.
pub fn read(
    root: &Path,
    deadline: Instant,
) -> Result<(String, bool, TurnInfo), crate::CommandError> {
    let turn = turns().get(root).cloned().ok_or_else(|| {
        crate::CommandError::invalid(
            "no agent turn seen here yet: the last turn shows from the next one an agent beside this diff starts",
        )
    })?;
    let unavailable = || crate::CommandError::unavailable("git could not read the turn in time");
    let store = store_for(root, deadline).ok_or_else(unavailable)?;
    let end = match &turn.end {
        Some(end) => end.clone(),
        None => snapshot(root, &store, deadline).ok_or_else(unavailable)?,
    };
    let (patch, truncated) = git::patch(
        Some(&store),
        root,
        &["diff-tree", "-r", "-M", &turn.start, &end],
        deadline,
    )
    .ok_or_else(unavailable)?;
    Ok((
        patch,
        truncated,
        TurnInfo {
            agent: turn.agent,
            ongoing: turn.end.is_none(),
        },
    ))
}

#[cfg(test)]
mod tests;
