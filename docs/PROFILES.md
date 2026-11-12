# Profiles

A profile is a named set of the settings the menus manage: the theme and its mode, the blinking cursor, asking before a send, and transparency. Each tmux session can use one (`tmuxy-core/src/profiles.rs`).

## The Default Profile

Every session starts on the **Default Profile**, which is not a file and changes nothing. A session on it gets what every session got before profiles existed: the config chain (`tmuxy.conf` and the rest, [TMUX-CONFIG.md](TMUX-CONFIG.md)), then the menus' remembered choices. A user who never picks a profile writes nothing new anywhere.

## Where profiles live

| What | Where |
| --- | --- |
| A named profile | `profiles/<name>.json` in the config dir, holding only what it changes |
| Which session uses which | `session_profiles` in `tmuxy.state.json`, with the menus' other choices, since tmux forgets a session's options when its server exits |

A profile's name is up to 64 letters, digits, spaces, `-`, `_` or `.`, not starting with `.`, so it is safe as a file name. A file with a key the schema does not know is refused rather than half-read.

## How a profile applies

When the app attaches to a session with a profile, after the config chain and the remembered choices, it sets the profile's values on that session only (`set-option -t <session>`), over the global ones, and tags the session with `@tmuxy-profile`. Other sessions keep the global settings. An option the user's `tmuxy.conf` pins stays pinned, as it does for the menus. A profile that is missing or does not parse is logged and skipped, and the session keeps the global settings.

## Tests

`profiles_tests.rs`, in scratch directories only:

- the Default Profile adds no command and leaves the state file as it was;
- a session's profile sets its values on that session only, and leaves pinned options alone;
- a broken or missing profile changes nothing;
- profiles are created, copied, renamed and deleted, and the default one cannot be;
- names and the file schema are checked.
