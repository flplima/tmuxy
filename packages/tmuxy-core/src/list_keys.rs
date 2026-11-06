//! `list-keys`: the command that prints a key table, the one reader of the
//! lines it prints, and the one rule for a table that will not list.
//!
//! Every reader of the bindings goes through here — the client's key tables
//! (`transport::KeyBindings`) and the plugin keys (`plugins::keys`), from the
//! monitor's control-mode connection and from a CLI verb's subprocess alike —
//! so the line format is parsed once and a failed read means the same thing
//! everywhere.

/// The `list-keys` that prints one whole table. Always the whole table:
/// before 3.8, `list-keys -T <table> <key>` answers nothing at all.
pub fn command(table: &str) -> String {
    format!("list-keys -T {table}")
}

/// One binding as `list-keys` prints it:
/// `bind-key [-r] -T <table> <key> <command…>`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Row<'a> {
    pub table: &'a str,
    /// The key as tmux prints it: a key that is also tmux syntax comes
    /// backslash-escaped (`\;`), see [`Row::key_name`].
    pub key: &'a str,
    /// The `-r` flag: the binding re-arms the prefix after it runs.
    pub repeat: bool,
    /// The command, its words joined by single spaces.
    pub command: String,
}

impl<'a> Row<'a> {
    /// The binding a `list-keys` line prints, or `None` for any other line.
    pub fn parse(line: &'a str) -> Option<Self> {
        let mut words = line.split_whitespace();
        if words.next() != Some("bind-key") {
            return None;
        }
        let mut flag = words.next()?;
        let repeat = flag == "-r";
        if repeat {
            flag = words.next()?;
        }
        if flag != "-T" {
            return None;
        }
        let table = words.next()?;
        let key = words.next()?;
        let command = words.collect::<Vec<_>>().join(" ");
        if command.is_empty() {
            return None;
        }
        Some(Self {
            table,
            key,
            repeat,
            command,
        })
    }

    /// The key's name, with the escape tmux prints a one-character key
    /// that is also its syntax with (`\;` is `;`) taken off.
    pub fn key_name(&self) -> &'a str {
        match self.key.strip_prefix('\\') {
            Some(rest) if rest.chars().count() == 1 => rest,
            _ => self.key,
        }
    }
}

pub fn rows(listing: &str) -> impl Iterator<Item = Row<'_>> {
    listing.lines().filter_map(Row::parse)
}

/// What tmux says when asked to list a table no binding has made yet.
const NO_SUCH_TABLE: &str = "doesn't exist";

/// A table's listing from tmux's answer to [`command`]. tmux refuses to list
/// a table with no bindings ("table … doesn't exist"): that is an empty
/// table. Any other failure is returned as it is, never read as "no
/// bindings" — binding blind could take a key the user bound.
pub fn listing<E: std::fmt::Display>(answer: Result<String, E>) -> Result<String, E> {
    match answer {
        Err(e) if e.to_string().contains(NO_SUCH_TABLE) => Ok(String::new()),
        other => other,
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn a_row_is_read_with_or_without_its_repeat_flag() {
        let plain = Row::parse("bind-key    -T prefix % split-window -h").unwrap();
        assert_eq!(
            (plain.table, plain.key, plain.repeat, plain.command.as_str()),
            ("prefix", "%", false, "split-window -h")
        );
        let repeat = Row::parse("bind-key -r -T prefix Up select-pane -U").unwrap();
        assert!(repeat.repeat);
        assert_eq!(repeat.key, "Up");
        let escaped = Row::parse(r"bind-key -T root \; send-keys x").unwrap();
        assert_eq!((escaped.key, escaped.key_name()), (r"\;", ";"));
        for not_a_binding in ["", "C-b", "bind-key -T prefix x", "set -g prefix C-a"] {
            assert_eq!(Row::parse(not_a_binding), None, "{not_a_binding:?}");
        }
    }

    /// An empty table is the one failure that means "no bindings"; a server
    /// that cannot be reached is not an empty table.
    #[test]
    fn only_a_table_that_does_not_exist_reads_as_empty() {
        assert_eq!(
            listing::<String>(Err("table root doesn't exist".into())),
            Ok(String::new())
        );
        assert!(listing::<String>(Err("no server running on /tmp/tmux-1/x".into())).is_err());
        assert_eq!(listing::<String>(Ok("b".into())), Ok("b".into()));
    }
}
