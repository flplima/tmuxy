//! How a session is sized when clients of different viewports watch it:
//! `@tmuxy-size` in `tmuxy.conf`.
//!
//! | value | the window is |
//! |---|---|
//! | `smallest` (default) | the smallest viewport among the clients, like tmux's own default |
//! | `largest` | the largest viewport; smaller clients scale the grid down to fit |
//! | `latest` | the viewport of the client that was used last; the others scale to fit |
//! | `COLSxROWS` (`80x25`) | that grid, whatever the clients measure; every client scales to fit |
//!
//! The scaling is the client's: the backend only picks the size here.

use serde::{Deserialize, Serialize};

/// The narrowest and shortest grid a fixed size may ask for.
const MIN_FIXED: (u32, u32) = (10, 5);
/// The widest and tallest: past this the cells are too small to read anywhere.
const MAX_FIXED: (u32, u32) = (1000, 500);

/// The `@tmuxy-size` choice, parsed. On the wire it is
/// `{ "mode": "smallest" | "largest" | "latest" }` or
/// `{ "mode": "fixed", "cols": 80, "rows": 25 }`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "lowercase")]
pub enum SizePolicy {
    #[default]
    Smallest,
    Largest,
    Latest,
    Fixed {
        cols: u32,
        rows: u32,
    },
}

impl SizePolicy {
    /// Parse an option value; anything unrecognised is the default,
    /// `smallest`. A fixed size is clamped to a usable grid.
    pub fn parse(value: &str) -> Self {
        let value = value.trim().to_ascii_lowercase();
        match value.as_str() {
            "smallest" => Self::Smallest,
            "largest" => Self::Largest,
            "latest" => Self::Latest,
            _ => value
                .split_once('x')
                .and_then(|(c, r)| {
                    Some((c.trim().parse::<u32>().ok()?, r.trim().parse::<u32>().ok()?))
                })
                .map_or(Self::Smallest, |(cols, rows)| Self::Fixed {
                    cols: cols.clamp(MIN_FIXED.0, MAX_FIXED.0),
                    rows: rows.clamp(MIN_FIXED.1, MAX_FIXED.1),
                }),
        }
    }

    /// The size the session should be, from every client's reported viewport
    /// and the one used last. `None` when there is nothing to size to yet: no
    /// client has reported, and the size is not fixed.
    pub fn resolve(
        &self,
        sizes: impl IntoIterator<Item = (u32, u32)>,
        latest: Option<(u32, u32)>,
    ) -> Option<(u32, u32)> {
        let mut sizes = sizes.into_iter().peekable();
        match *self {
            Self::Fixed { cols, rows } => Some((cols, rows)),
            _ if sizes.peek().is_none() => None,
            Self::Smallest => sizes.reduce(|(c, r), (c2, r2)| (c.min(c2), r.min(r2))),
            Self::Largest => sizes.reduce(|(c, r), (c2, r2)| (c.max(c2), r.max(r2))),
            Self::Latest => latest.or_else(|| sizes.last()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_every_form_and_falls_back_to_smallest() {
        assert_eq!(SizePolicy::parse("smallest"), SizePolicy::Smallest);
        assert_eq!(SizePolicy::parse(" Largest "), SizePolicy::Largest);
        assert_eq!(SizePolicy::parse("latest"), SizePolicy::Latest);
        assert_eq!(
            SizePolicy::parse("80x25"),
            SizePolicy::Fixed { cols: 80, rows: 25 }
        );
        assert_eq!(
            SizePolicy::parse("120X40"),
            SizePolicy::Fixed {
                cols: 120,
                rows: 40
            }
        );
        for junk in ["", "big", "80x", "x25", "80x25x3", "-1x20", "80 25"] {
            assert_eq!(SizePolicy::parse(junk), SizePolicy::Smallest, "{junk:?}");
        }
    }

    #[test]
    fn a_fixed_size_is_clamped_to_a_usable_grid() {
        assert_eq!(
            SizePolicy::parse("1x1"),
            SizePolicy::Fixed { cols: 10, rows: 5 }
        );
        assert_eq!(
            SizePolicy::parse("99999x99999"),
            SizePolicy::Fixed {
                cols: 1000,
                rows: 500
            }
        );
    }

    #[test]
    fn resolves_each_policy_over_the_reported_sizes() {
        let sizes = [(200, 50), (80, 60), (120, 30)];
        assert_eq!(SizePolicy::Smallest.resolve(sizes, None), Some((80, 30)));
        assert_eq!(SizePolicy::Largest.resolve(sizes, None), Some((200, 60)));
        assert_eq!(
            SizePolicy::Latest.resolve(sizes, Some((80, 60))),
            Some((80, 60))
        );
        assert_eq!(
            SizePolicy::Fixed { cols: 90, rows: 20 }.resolve(sizes, None),
            Some((90, 20))
        );
    }

    #[test]
    fn only_a_fixed_size_resolves_with_no_client() {
        for policy in [
            SizePolicy::Smallest,
            SizePolicy::Largest,
            SizePolicy::Latest,
        ] {
            assert_eq!(policy.resolve([], None), None, "{policy:?}");
        }
        assert_eq!(
            SizePolicy::Fixed { cols: 80, rows: 25 }.resolve([], None),
            Some((80, 25))
        );
    }

    #[test]
    fn the_wire_shape_is_a_tagged_mode() {
        assert_eq!(
            serde_json::to_value(SizePolicy::Fixed { cols: 80, rows: 25 }).unwrap(),
            serde_json::json!({ "mode": "fixed", "cols": 80, "rows": 25 })
        );
        assert_eq!(
            serde_json::to_value(SizePolicy::Latest).unwrap(),
            serde_json::json!({ "mode": "latest" })
        );
    }
}
