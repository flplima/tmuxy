//! Validated identifiers for the tmux objects tmuxy names.
//!
//! tmux spells its ids with a one-character sigil and a number — `%3` for a
//! pane, `@1` for a window — and tmuxy mints group ids the same way from the
//! anchor pane (`g3`, see [`GroupId::from_anchor`]). Each kind is its own type
//! so a window id cannot be passed where a pane is meant, and the spelling is
//! checked once, where the text arrives (a control-mode line, a CLI argument,
//! a client command), instead of at every use.
//!
//! On the wire an id is the bare string it always was: serialization is
//! transparent, and deserialization is the same string checked. The canonical
//! spelling has no leading zero, which is what makes two ids equal exactly
//! when their numbers are.

use std::borrow::Borrow;
use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Deserializer, Serialize};

/// A string that does not spell the id it was meant to.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("not a {kind} id: {value:?}")]
pub struct IdError {
    pub kind: &'static str,
    pub value: String,
}

/// `<sigil><digits>` with no leading zero (`0` itself is fine).
fn is_canonical(value: &str, sigil: char) -> bool {
    let Some(digits) = value.strip_prefix(sigil) else {
        return false;
    };
    !digits.is_empty()
        && digits.bytes().all(|b| b.is_ascii_digit())
        && (digits == "0" || !digits.starts_with('0'))
        && digits.parse::<u32>().is_ok()
}

macro_rules! tmux_id {
    ($(#[$doc:meta])* $name:ident, $sigil:literal, $kind:literal) => {
        $(#[$doc])*
        #[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize)]
        #[serde(transparent)]
        pub struct $name(String);

        impl $name {
            /// Check `value` and take it as an id.
            pub fn parse(value: &str) -> Result<Self, IdError> {
                if is_canonical(value, $sigil) {
                    Ok(Self(value.to_string()))
                } else {
                    Err(IdError {
                        kind: $kind,
                        value: value.to_string(),
                    })
                }
            }

            /// The id with this number.
            pub fn from_number(number: u32) -> Self {
                Self(format!("{}{number}", $sigil))
            }

            /// The id as tmux spells it.
            pub fn as_str(&self) -> &str {
                &self.0
            }

            /// The number after the sigil.
            pub fn number(&self) -> u32 {
                // Checked by `parse`/`from_number`, the only ways in.
                self.0[1..].parse().unwrap_or_default()
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str(&self.0)
            }
        }

        impl FromStr for $name {
            type Err = IdError;
            fn from_str(value: &str) -> Result<Self, IdError> {
                Self::parse(value)
            }
        }

        impl TryFrom<&str> for $name {
            type Error = IdError;
            fn try_from(value: &str) -> Result<Self, IdError> {
                Self::parse(value)
            }
        }

        impl TryFrom<String> for $name {
            type Error = IdError;
            fn try_from(value: String) -> Result<Self, IdError> {
                if is_canonical(&value, $sigil) {
                    Ok(Self(value))
                } else {
                    Err(IdError { kind: $kind, value })
                }
            }
        }

        impl From<$name> for String {
            fn from(id: $name) -> String {
                id.0
            }
        }

        impl AsRef<str> for $name {
            fn as_ref(&self) -> &str {
                &self.0
            }
        }

        /// Maps keyed by id answer a lookup by `&str` too. Sound because the
        /// derived `Hash`/`Eq` are the inner string's.
        impl Borrow<str> for $name {
            fn borrow(&self) -> &str {
                &self.0
            }
        }

        impl PartialEq<str> for $name {
            fn eq(&self, other: &str) -> bool {
                self.0 == other
            }
        }

        impl PartialEq<&str> for $name {
            fn eq(&self, other: &&str) -> bool {
                self.0 == *other
            }
        }

        impl PartialEq<$name> for str {
            fn eq(&self, other: &$name) -> bool {
                self == other.0
            }
        }

        impl PartialEq<$name> for &str {
            fn eq(&self, other: &$name) -> bool {
                *self == other.0
            }
        }

        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
                let value = String::deserialize(deserializer)?;
                Self::try_from(value).map_err(serde::de::Error::custom)
            }
        }
    };
}

tmux_id!(
    /// A tmux pane, `%N`. Never reused within a server.
    ///
    /// SEC-17: a client that names a pane names it this way — it only ever
    /// learned ids from `list-panes` — so anything else (`other:0.0`,
    /// `{last}`, a name) is not a pane the client was shown, and is refused
    /// before it reaches tmux.
    PaneId,
    '%',
    "pane"
);

tmux_id!(
    /// A tmux window, `@N`.
    WindowId,
    '@',
    "window"
);

tmux_id!(
    /// A pane group, `gN` — the `@tmuxy-group-id` every member carries.
    GroupId,
    'g',
    "group"
);

impl GroupId {
    /// The id a group opened from `anchor` gets: `%5` → `g5`. Pane ids are
    /// never reused within a server, so it is unique for the group's life.
    pub fn from_anchor(anchor: &PaneId) -> Self {
        Self::from_number(anchor.number())
    }
}

/// Literal ids for tests: `pid("%3")` reads better than a parse and unwrap.
#[cfg(test)]
#[allow(clippy::unwrap_used)]
pub(crate) mod test_ids {
    use super::*;

    pub fn pid(s: &str) -> PaneId {
        PaneId::parse(s).unwrap()
    }

    pub fn wid(s: &str) -> WindowId {
        WindowId::parse(s).unwrap()
    }

    pub fn gid(s: &str) -> GroupId {
        GroupId::parse(s).unwrap()
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[test]
    fn canonical_ids_parse_and_round_trip() {
        for s in ["%0", "%7", "%1234"] {
            let id: PaneId = s.parse().unwrap();
            assert_eq!(id.as_str(), s);
            assert_eq!(id.to_string(), s);
        }
        assert_eq!(PaneId::parse("%42").unwrap().number(), 42);
        assert_eq!(WindowId::parse("@3").unwrap().number(), 3);
        assert_eq!(GroupId::parse("g9").unwrap().number(), 9);
    }

    #[test]
    fn anything_else_is_refused() {
        for bad in [
            "",
            "%",
            "7",
            "%7a",
            "%-1",
            "%07",
            "@1",
            "other:0.0",
            "{last}",
            "%7 ; kill-server",
            "%99999999999",
        ] {
            assert!(PaneId::parse(bad).is_err(), "{bad:?}");
        }
        assert!(WindowId::parse("%1").is_err());
        assert!(GroupId::parse("G1").is_err());
        assert_eq!(
            PaneId::parse("x").unwrap_err().to_string(),
            "not a pane id: \"x\""
        );
    }

    #[test]
    fn the_wire_shape_is_the_bare_string() {
        let id = PaneId::parse("%5").unwrap();
        assert_eq!(serde_json::to_string(&id).unwrap(), "\"%5\"");
        let back: PaneId = serde_json::from_str("\"%5\"").unwrap();
        assert_eq!(back, id);
        assert!(serde_json::from_str::<PaneId>("\"5\"").is_err());
        assert!(serde_json::from_str::<WindowId>("\"%5\"").is_err());
    }

    #[test]
    fn a_map_keyed_by_id_answers_a_str_lookup() {
        let mut map = HashMap::new();
        map.insert(PaneId::from_number(3), "three");
        assert_eq!(map.get("%3"), Some(&"three"));
        assert_eq!(PaneId::from_number(3), "%3");
    }

    #[test]
    fn a_group_is_named_after_its_anchor() {
        let anchor = PaneId::parse("%5").unwrap();
        assert_eq!(GroupId::from_anchor(&anchor), "g5");
    }
}
