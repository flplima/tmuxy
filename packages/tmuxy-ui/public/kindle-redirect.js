// `?kindle` opens the e-ink page (kindle.html) instead of the app. A classic
// script ahead of the app's bundle, written for any engine: the browsers it is
// for cannot parse the bundle, so the bundle cannot make this choice itself.
if (/[?&]kindle(=|&|$)/.test(window.location.search)) {
  window.location.replace('/kindle.html' + window.location.search);
}
