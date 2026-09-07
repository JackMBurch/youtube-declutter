# Changelog

Notable changes to YouTube Declutter. Versions match the `@version` field in
`youtube-declutter.user.js`.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
uses [semantic versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Renamed the script file from `youtube-decultter.user.js` to `youtube-declutter.user.js`,
  correcting a typo before the first publish bakes it into every install URL.

### Added

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
