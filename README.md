# YouTube Declutter

A userscript that declutters YouTube on mobile and desktop. Built for iOS, where the
alternatives are an app you cannot modify or a browser you do not want.

Runs on `www.youtube.com`, `m.youtube.com` and `youtube.com` at `document-start`, with
`@grant none`, so it works in any userscript manager without special privileges.

## What it does

| Feature | Effect |
|---|---|
| Hide Shorts button | Removes Shorts from the bottom bar on mobile and the sidebar on desktop |
| Hide Shorts rows | Removes Shorts shelves wherever they appear in feeds and search |
| Hide community posts | Removes text and poll posts from feeds, and some news shelves |
| Hide promo banners | Removes the large "YouTube featured" cards at the top of home |
| Replace yoodles | Swaps holiday and campaign logos for the normal logo |
| Customise sidebar | Hide and reorder sidebar entries, with drag to reorder |
| Add extra sidebar items | Adds Subscriptions, Watch later and Playlists |
| Home feed | Leave alone, hide recommendations but keep chips, or hide the feed entirely |

Settings live behind a gear button mounted in the sidebar footer. Backup and restore are
built in, so a working configuration survives a reinstall.

## Recovery

Sidebar customisation can in principle hide the very buttons used to undo it. These URL
hashes work with no UI at all. Append one and reload:

```
m.youtube.com/#ytdc-reset   wipe all settings
m.youtube.com/#ytdc-show    unhide every sidebar entry
m.youtube.com/#ytdc-safe    disable sidebar features for this session
```

`#ytdc-safe` survives YouTube's redirect from `m.youtube.com/#ytdc-safe` to `/?ra=m`, which
drops the hash, by writing a short-lived marker that the post-redirect load picks up.

## Install

Not yet published. Once it is on Greasy Fork, installing from there gives automatic updates.
Until then, paste the contents of `youtube-declutter.user.js` into your userscript manager.

Tested against Stay on iOS. Any Tampermonkey- or Violentmonkey-compatible manager should work,
since the script requests no `GM_*` privileges.

## Development

The version is declared twice, in `@version` and in `const VERSION`, and the two must not
drift. From the release tooling onward, that is enforced rather than remembered.

Working notes, plans and epic trackers live in `.workspace/`, which is a separate git
repository excluded from this one. See `.workspace/README.md`.

## Licence

MIT. See `LICENSE`.
