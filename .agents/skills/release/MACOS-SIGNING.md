# macOS signing (one-time setup)

Part of the release skill ([SKILL.md](SKILL.md)).

The macOS build signs and notarizes itself when — and only when — these repository secrets exist. The Tauri CLI reads them during `tauri build`: it imports the certificate into a throwaway keychain, signs with the hardened runtime, then notarizes and staples. With `APPLE_CERTIFICATE` absent it skips signing silently, so forks and PRs still produce a working (unsigned) DMG.

| Secret | What it is |
|---|---|
| `APPLE_CERTIFICATE` | base64 of the **Developer ID Application** `.p12`. An *Apple Development* cert is NOT enough — it fails Gatekeeper on every machine but the ones registered to it |
| `APPLE_CERTIFICATE_PASSWORD` | the password set when exporting that `.p12` |
| `APPLE_SIGNING_IDENTITY` | the identity's full name, e.g. `Developer ID Application: Felipe Lima (NF27TT2TR8)` |
| `APPLE_API_KEY` | App Store Connect key ID (the `XXXXXXXXXX` in `AuthKey_XXXXXXXXXX.p8`) |
| `APPLE_API_ISSUER` | the issuer UUID shown above the key list |
| `APPLE_API_KEY_P8` | base64 of the `.p8` itself — staged to a file at build time, since notarization wants a path |

The API key is used rather than `APPLE_ID` + an app-specific password because it carries no 2FA and can be revoked without touching the Apple ID. Apple issues a `.p8` **once**; losing it means minting a new key.

Signing changes nothing about the cask — Homebrew already strips the quarantine xattr — but it removes the *"couldn't verify tmuxy's signer"* warning and lets the app open on a Mac that downloaded the DMG directly.

**The DMG is notarized separately from the app it contains.** The Tauri CLI notarizes and staples the `.app`, then wraps it in a disk image, so the image carries a Developer ID signature and no ticket of its own. Mounted, the app is accepted; but a browser-downloaded DMG is quarantined, and Gatekeeper assesses the *image* before anything inside it — `spctl -a -t open` rejects it as `source=Unnotarized Developer ID` and the user gets "cannot be opened" on the file they just downloaded. v0.0.10-alpha.67 and .68 both shipped that way. `build-app.yml` now submits the image too and staples the ticket into it, and the tag-build assertion checks the DMG as well as the app, so a future one fails the job instead of reaching a user.
