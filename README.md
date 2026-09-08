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

Editing this on a phone by copy/paste is unbearable, so `dev/serve.py` serves the working
copy and a generated loader fetches it on every page load. Open the printed address on the
phone and import the loader URL once; after that, saving here and reloading there is the
whole cycle. The same page offers a plain copy of the script for when you are not debugging.

```
python3 dev/serve.py            # serve the script and the loader
scripts/ios-debug.sh cdp        # DevTools over USB, from Linux
scripts/ios-log.mjs             # stream the device console to a file
node tests/run.mjs              # the checks that do not need a phone
scripts/release.sh minor        # bump both version fields together
```

`scripts/ios-debug.sh` uses `pymobiledevice3` to bridge Apple's Web Inspector protocol to
the Chrome DevTools Protocol, so a Linux machine can debug the phone; Safari's Develop menu
is not required and neither is a Mac.

The version is declared twice, in `@version` and in `const VERSION`, and the two must not
drift: a manager decides whether to update by comparing `@version`, while the boot line and
debug sheet report `const VERSION`. `scripts/release.sh` is the only thing that should write
either, and CI fails a pull request that changes the script without raising the version.

Working notes, plans and epic trackers live in `.workspace/`, which is a separate git
repository excluded from this one. See `.workspace/README.md`.

## Licence

MIT. See `LICENSE`.
