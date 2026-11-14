//! A patch as git prints it, read into files, hunks and numbered lines.
//!
//! Everything here is untrusted text (file names and contents are anyone's),
//! kept as strings: nothing is interpreted, and the client renders it as
//! text. A line the reader does not know is skipped, never guessed at.

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum FileStatus {
    Modified,
    Added,
    Deleted,
    Renamed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LineKind {
    /// The same on both sides.
    Context,
    Added,
    Removed,
    /// git's `\ No newline at end of file`.
    Note,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffLine {
    pub kind: LineKind,
    /// Its number in the old file, when it is in it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old: Option<u32>,
    /// Its number in the new file, when it is in it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub new: Option<u32>,
    /// The line, without the `+`, `-` or space git puts first.
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hunk {
    /// The `@@ -a,b +c,d @@ …` line, as git printed it.
    pub header: String,
    pub lines: Vec<DiffLine>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffFile {
    /// Its path in the checkout, after the change.
    pub path: String,
    /// Its path before a rename.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_path: Option<String>,
    pub status: FileStatus,
    /// git says the file is binary: there are no lines to show.
    pub binary: bool,
    /// Its mode changed (`old mode 100644`, `new mode 100755`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode_change: Option<String>,
    pub hunks: Vec<Hunk>,
}

/// A path as git prints it: `"…"` C-quoted when it holds a character git
/// will not print bare, then the `a/`/`b/` prefix, and a tab git adds after
/// a name with a space. `None` for `/dev/null`.
fn path_of(raw: &str, prefix: &str) -> Option<String> {
    let raw = raw.strip_suffix('\t').unwrap_or(raw);
    let raw = if raw.starts_with('"') {
        unquote(raw)?
    } else {
        raw.to_string()
    };
    if raw == "/dev/null" {
        return None;
    }
    Some(visible(raw.strip_prefix(prefix).unwrap_or(&raw)))
}

/// A file name with every control character shown as its picture (`\t` as
/// `␉`, ESC as `␛`): a name is a label on screen, and a control character in
/// one would move or recolour what is drawn after it.
fn visible(name: &str) -> String {
    name.chars()
        .map(|c| match u32::from(c) {
            code @ 0..=0x1f => char::from_u32(0x2400 + code).unwrap_or('?'),
            0x7f => '\u{2421}',
            _ => c,
        })
        .collect()
}

/// A C-quoted string as git writes one (`"a\tb\303\251"`), its bytes read
/// back as UTF-8.
fn unquote(quoted: &str) -> Option<String> {
    let inner = quoted.strip_prefix('"')?.strip_suffix('"')?;
    let mut bytes = Vec::with_capacity(inner.len());
    let mut chars = inner.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            let mut buf = [0; 4];
            bytes.extend_from_slice(c.encode_utf8(&mut buf).as_bytes());
            continue;
        }
        match chars.next()? {
            'n' => bytes.push(b'\n'),
            't' => bytes.push(b'\t'),
            'r' => bytes.push(b'\r'),
            'a' => bytes.push(7),
            'b' => bytes.push(8),
            'f' => bytes.push(12),
            'v' => bytes.push(11),
            d @ '0'..='7' => {
                let mut value = d.to_digit(8)?;
                for _ in 0..2 {
                    value = value * 8 + chars.next()?.to_digit(8)?;
                }
                bytes.push(u8::try_from(value).ok()?);
            }
            other => {
                let mut buf = [0; 4];
                bytes.extend_from_slice(other.encode_utf8(&mut buf).as_bytes());
            }
        }
    }
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

/// The path a `diff --git a/P b/P` header names when nothing else does (a
/// binary file, a mode change): the two halves of an unquoted header are the
/// same path, so its length says where they split.
fn header_path(header: &str) -> Option<String> {
    let rest = header.strip_prefix("diff --git ")?;
    if let Some(quoted) = rest.strip_prefix('"') {
        let end = quoted.find("\" ")? + 2;
        return path_of(&rest[..end], "a/");
    }
    let half = rest.len().checked_sub(5)? / 2;
    let (old, new) = (rest.get(2..2 + half)?, rest.get(rest.len() - half..)?);
    (old == new && rest.get(2 + half..rest.len() - half)? == " b/").then(|| old.to_string())
}

/// `@@ -a[,b] +c[,d] @@`: the first old and new line numbers.
fn hunk_start(header: &str) -> Option<(u32, u32)> {
    let mut words = header.split_whitespace().skip(1);
    let number = |word: &str, sign: char| {
        word.strip_prefix(sign)?
            .split(',')
            .next()?
            .parse::<u32>()
            .ok()
    };
    let old = number(words.next()?, '-')?;
    let new = number(words.next()?, '+')?;
    Some((old, new))
}

fn new_file(header: &str) -> DiffFile {
    DiffFile {
        path: header_path(header).unwrap_or_default(),
        old_path: None,
        status: FileStatus::Modified,
        binary: false,
        mode_change: None,
        hunks: Vec::new(),
    }
}

/// The lines of a file's header, between `diff --git` and its first hunk.
fn header_line(file: &mut DiffFile, line: &str, old_mode: &mut Option<String>) {
    if line.starts_with("new file mode") {
        file.status = FileStatus::Added;
    } else if line.starts_with("deleted file mode") {
        file.status = FileStatus::Deleted;
    } else if let Some(from) = line.strip_prefix("rename from ") {
        file.status = FileStatus::Renamed;
        file.old_path = path_of(from, "");
    } else if let Some(to) = line.strip_prefix("rename to ") {
        if let Some(path) = path_of(to, "") {
            file.path = path;
        }
    } else if let Some(mode) = line.strip_prefix("old mode ") {
        *old_mode = Some(mode.to_string());
    } else if let Some(mode) = line.strip_prefix("new mode ") {
        file.mode_change = Some(format!("{} → {mode}", old_mode.take().unwrap_or_default()));
    } else if line.starts_with("Binary files ") || line == "GIT binary patch" {
        file.binary = true;
    } else if let Some(old) = line.strip_prefix("--- ") {
        if file.old_path.is_none()
            && file.status != FileStatus::Renamed
            && path_of(old, "a/").is_none()
        {
            file.status = FileStatus::Added;
        }
    } else if let Some(new) = line.strip_prefix("+++ ") {
        match path_of(new, "b/") {
            Some(path) => file.path = path,
            None => file.status = FileStatus::Deleted,
        }
    }
}

/// `patch`'s files, in the order git printed them. A file whose path could
/// not be read is left out.
pub fn parse(patch: &str) -> Vec<DiffFile> {
    let mut files: Vec<DiffFile> = Vec::new();
    let mut file: Option<DiffFile> = None;
    let mut old_mode = None;
    let mut numbers = (0u32, 0u32);
    for line in patch.lines() {
        if line.starts_with("diff --git ") {
            files.extend(file.take());
            file = Some(new_file(line));
            old_mode = None;
            continue;
        }
        let Some(current) = file.as_mut() else {
            continue;
        };
        if line.starts_with("@@ ") {
            if let Some(start) = hunk_start(line) {
                numbers = start;
                current.hunks.push(Hunk {
                    header: line.to_string(),
                    lines: Vec::new(),
                });
            }
            continue;
        }
        let Some(hunk) = current.hunks.last_mut() else {
            header_line(current, line, &mut old_mode);
            continue;
        };
        let (old, new) = &mut numbers;
        let (kind, old_no, new_no) = match line.chars().next() {
            Some(' ') => (LineKind::Context, Some(*old), Some(*new)),
            Some('-') => (LineKind::Removed, Some(*old), None),
            Some('+') => (LineKind::Added, None, Some(*new)),
            Some('\\') => (LineKind::Note, None, None),
            _ => continue,
        };
        if old_no.is_some() {
            *old += 1;
        }
        if new_no.is_some() {
            *new += 1;
        }
        let text = if kind == LineKind::Note {
            line.trim_start_matches('\\').trim_start()
        } else {
            &line[1..]
        };
        hunk.lines.push(DiffLine {
            kind,
            old: old_no,
            new: new_no,
            text: text.to_string(),
        });
    }
    files.extend(file);
    files.retain(|file| !file.path.is_empty());
    files
}
