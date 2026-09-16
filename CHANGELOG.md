# Changelog

Notable changes to YouTube Declutter. Versions match the `@version` field in
`youtube-declutter.user.js`.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
uses [semantic versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.2.1] - 2026-09-16

### Changed

- Description now says the script is for mobile YouTube in Edge on iOS.

## [1.2.0] - 2026-09-16

### Added

- Stop video previews, off by default. Thumbnails play a silent preview when they think you
  are interested, which on a phone mostly starts by accident while scrolling. Detection is
  structural rather than by class name, and it only ever pauses muted video, so it cannot
  silence something you are listening to.
- Offline checks (`node tests/run.mjs`) and a CI workflow that refuses a change to the
  script without a version bump.
- Published on Greasy Fork as script 596100. `@updateURL` and `@downloadURL` point there, so
  a copy pasted from anywhere else still receives updates.

## [1.1.0] - 2026-09-07

### Changed

- Renamed the script file from `youtube-decultter.user.js` to `youtube-declutter.user.js`,
  correcting a typo before the first publish bakes it into every install URL.

### Fixed

- Icons no longer throw under YouTube's Trusted Types policy. Every inline SVG was assigned
  through `innerHTML`, which YouTube's `require-trusted-types-for` rejects with "This
  assignment requires a TrustedHTML", so assignments now go through a policy that returns
  the markup unchanged. The throw happened inside the observer reacting to YouTube's DOM
  churn, so it repeated, and Stay responded by abandoning its page-world injection and
  falling back to a content-world one - the script then ran twice and the page reloaded in
  a loop. One cause, three symptoms.

### Added

- Background play, off by default: masks `document.hidden` and `visibilityState` and
  swallows visibility events, so switching tabs inside the browser no longer pauses
  playback. It cannot help when you leave the browser or lock the screen - iOS suspends the
  page and only Picture in Picture survives that. Technique from Greasy Fork script 560972
  (CC-BY-4.0), reimplemented rather than copied.
- Picture in Picture button on the player, off by default. iOS grants PiP only from a real
  tap, and refuses a scripted call silently - returning normally while the mode stays
  `inline` - so this cannot be automatic, and the result is logged rather than assumed.
  It is also the only way to keep audio going after leaving the app: resuming the pause iOS
  performs on backgrounding was tried and does not work, because background audio is granted
  by user intent carried through the media session, not by a media element asking.
- Runs once per document even when injected twice, guarded on a DOM marker rather than a
  `window` flag, because the two copies get separate JavaScript contexts and share only the
  DOM.
- Console logging: one `[ytdc] boot` line reporting version, path, safe mode and which
  features are on, plus a warning when the sidebar guard bails. Deliberately quiet, because
  the script is observed through a remote inspector over USB and a chatty page makes that
  crawl. Detail is stringified, since an object argument reaches a remote console as its
  class name with the contents dropped.
- Repository foundation: licence, readme, changelog and ignore rules.

## [1.0.17] - 2026-09-07

First version tracked in version control. Released previously by hand; this entry records the
starting point rather than reconstructing the history behind it.

### Features

- Hide Shorts button, Shorts rows, community posts and home promo banners.
- Replace holiday and campaign logos with the normal logo.
- Customise the sidebar: hide entries, reorder by drag, add Subscriptions, Watch later and
  Playlists.
- Home feed modes: leave alone, hide recommendations while keeping chips, or hide entirely.
- Backup and restore of all settings.
- URL-hash recovery escapes (`#ytdc-reset`, `#ytdc-show`, `#ytdc-safe`) that work with no UI,
  including surviving YouTube's redirect that drops the hash.
- Debug sheet reporting live state, with copy to clipboard.
