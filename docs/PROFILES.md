# Profiles

A profile is a named set of the menus' look-and-feel settings: the theme and its mode, the blinking cursor and transparency. Each tmux session can use one (`tmuxy-core/src/profiles.rs`).

## The Default Profile

Every session starts on the **Default Profile**, which is not a file and changes nothing. A session on it gets what every session got before profiles existed: the config chain (`tmuxy.conf` and the rest, [TMUX-CONFIG.md](TMUX-CONFIG.md)), then the menus' remembered choices. A user who never picks a profile writes nothing new anywhere.

## Where profiles live

| What | Where |
| --- | --- |
| A named profile | `profiles/<name>.json` in the config dir, holding only what it changes |
| Which session uses which | `session_profiles` in `tmuxy.state.json`, with the menus' other choices, since tmux forgets a session's options when its server exits |

A profile's name is up to 64 letters, digits, spaces, `-`, `_` or `.`, not starting with `.`, so it is safe as a file name. A profile holds those four keys (`theme`, `themeMode`, `cursorBlink`, `transparency`) and nothing else. A key that guards access, such as asking before keys are sent to a pane, is refused by name: a profile file is plain JSON any program of the user's can write, so it never loosens a security setting. Any other unknown key, a theme that is not a theme file's name, or a mode other than `dark`, `light` or `auto` is refused too, rather than half-read.

Sessions are matched by name: a renamed session loses its profile, and a new session given an old name gets it.

## How a profile applies

When the app attaches to a session with a profile, after the config chain and the remembered choices, it sets the profile's values on that session only (`set-option -t <session>`), over the global ones, and tags the session with `@tmuxy-profile`. Other sessions keep the global settings. An option the user's `tmuxy.conf` pins stays pinned, as it does for the menus. A profile that is missing or does not parse is logged and skipped, and the session keeps the global settings.

## The View menu

View > Profiles lists every profile, the session's checked, the Default Profile first. Picking one moves the session to it at once: the server unsets what the last profile set on the session, sets the new one's values, remembers the choice, and sends every client of the session the theme settings again, which tmux resolves from the session's own options first. The page repaints with no reload, and other sessions keep theirs.

| Item | What it does |
| --- | --- |
| New Profile... | Makes an empty profile (one that changes nothing) and moves the session to it |
| Duplicate Profile... | Copies the session's profile under a new name and moves the session to the copy |
| Rename Profile... | Renames the file, and every session that used it follows |
| Delete Profile... | Deletes the file after a confirmation; sessions that used it go back to the Default Profile |

Rename and Delete are greyed out on the Default Profile. A name is checked in the dialog as it is typed (empty, padded or taken), and the server checks it again. The client calls are `list_profiles`, `use_profile`, `create_profile`, `rename_profile` and `delete_profile` (`tmuxy-core/src/host/profiles.rs`), and each answers the profiles and the session's. The desktop's native menu bar is built from the same spec (`components/menus/specs/profilesMenu.ts`), so it has the same submenu.

## Changes are saved to the profile

In a session on a named profile, a change made from the menus (a theme, its mode, the blinking cursor, transparency) is saved into the profile's file and set on that session only, then painted at once (`into_profile` in `tmuxy-core/src/host/profiles.rs`). The global choices in `tmuxy.state.json`, and every other session, stay as they were. On the Default Profile a change is the global one it always was. Asking before a send is never saved into a profile: it stays global whichever profile the session uses. An option `tmuxy.conf` pins is refused as it is on the Default Profile, and a value no theme could have is never saved. Two tabs changing the same profile at once both keep their change. Another session on the same profile is painted with the change when it next attaches, not at once: only the session the change was made in is set live.

## Tests

`profiles_tests.rs` and `profilesMenu.test.ts`, in scratch directories only:

- the Default Profile adds no command and leaves the state file as it was;
- a session's profile sets its values on that session only, and leaves pinned options alone;
- a broken or missing profile changes nothing;
- profiles are created, copied, renamed and deleted, and the default one cannot be;
- names and the file schema are checked, and a theme or mode no theme could have is refused;
- a profile setting any security key, `sendAsk` off among them, is refused, and no profile field reaches the send-ask option.
- a switch unsets the last profile's options first, and the session map is written whole;
- the submenu checks the session's profile and greys out Rename and Delete on the default;
- `tests/29-profiles.test.js` drives View > Profiles in a browser: pick, duplicate, rename (a taken name refused in the dialog), delete and new, with the page repainted live and the files and the session map checked at each step.
- a menu change sets the profile's field, and never send-ask; `tests/29-profiles.test.js` picks a theme and a mode in a profiled session and checks the profile file holds them, the global choices are unchanged and the Default Profile paints as before.
