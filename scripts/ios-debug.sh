#!/usr/bin/env bash
#
# Attach a desktop debugger to web content running on the iPhone, from Linux.
#
# Apple's own client (Safari's Develop menu) needs a Mac. The device-side toggle does not:
# pymobiledevice3 speaks Apple's Web Inspector protocol and bridges it to the Chrome
# DevTools Protocol, so Chromium becomes the client instead of Safari-on-a-Mac.
#
# Usage:
#   scripts/ios-debug.sh check    verify the whole chain without starting anything
#   scripts/ios-debug.sh tabs     list inspectable targets and exit
#   scripts/ios-debug.sh cdp      start the bridge (default)
#
# The `tabs` command is what answers the open question in the plan: whether Edge's
# WKWebView is inspectable at all. Third-party webviews only appear if the app opted in
# with `webView.isInspectable = true`, required since iOS 16.4, and a production App Store
# build almost certainly has not. Run `tabs` with Safari open, then again with Edge open,
# and compare. If Edge never appears, debug in Safari + Stay and keep deploying to Edge:
# both are WebKit on iOS, so nearly every bug reproduces.

set -euo pipefail

CMD="${1:-cdp}"
PORT="${PORT:-9222}"

say()  { printf '%s\n' "$*"; }
ok()   { printf '  ok    %s\n' "$*"; }
bad()  { printf '  FAIL  %s\n' "$*"; }
note() { printf '        %s\n' "$*"; }

fail=0

say "Checking the chain from this machine to the phone."
say ""

# 1. The bridge itself.
if command -v pymobiledevice3 >/dev/null 2>&1; then
  ok "pymobiledevice3 $(pymobiledevice3 version 2>/dev/null || echo '(version unknown)')"
else
  bad "pymobiledevice3 not installed"
  note "pacman -S --needed python-pipx && pipx install pymobiledevice3"
  fail=1
fi

# 2. usbmuxd is what carries every message to the device over USB. Without it running,
#    the device is invisible even when it is plugged in and trusted.
if systemctl is-active --quiet usbmuxd 2>/dev/null; then
  ok "usbmuxd running"
else
  bad "usbmuxd not running"
  note "sudo systemctl enable --now usbmuxd"
  fail=1
fi

# 3. The device, and whether this host is trusted by it. These are different failures:
#    an attached-but-unpaired phone looks almost identical to an absent one.
if command -v idevice_id >/dev/null 2>&1; then
  udids="$(idevice_id -l 2>/dev/null || true)"
  if [ -n "$udids" ]; then
    ok "device attached: $(echo "$udids" | tr '\n' ' ')"
    if idevicepair validate >/dev/null 2>&1; then
      ok "host is paired and trusted"
    else
      bad "device attached but not paired"
      note "run: idevicepair pair    then tap Trust on the phone and re-run"
      fail=1
    fi
  else
    bad "no device found"
    note "plug the phone in over USB, unlock it, and tap Trust if prompted"
    fail=1
  fi
else
  bad "libimobiledevice tools missing"
  note "sudo pacman -S --needed usbmuxd libimobiledevice"
  fail=1
fi

say ""
say "On the phone, Web Inspector must be ON:"
say "  iOS 18+   Settings > Apps > Safari > Advanced > Web Inspector"
say "  iOS 17-   Settings > Safari > Advanced > Web Inspector"
say "This is a device setting, not a Mac one, and it gates every target below."
say ""

if [ "$fail" -ne 0 ]; then
  say "Chain incomplete. Fix the FAIL lines above, then re-run."
  exit 1
fi

case "$CMD" in
  check)
    say "Chain complete. Next: scripts/ios-debug.sh tabs"
    ;;

  tabs)
    say "Inspectable targets. Safari tabs appear automatically; a third-party"
    say "browser appears only if that app opted into being inspectable."
    say ""
    pymobiledevice3 webinspector opened-tabs || {
      say ""
      say "No targets, or the listing failed. Two likely causes:"
      say "  - Web Inspector is off on the device, or no browser tab is open."
      say "  - iOS 17+ moved developer services behind an RSD tunnel. If the error"
      say "    mentions a tunnel or RemoteXPC, that is this, not a missing device."
      exit 1
    }
    ;;

  cdp)
    say "Starting the CDP bridge on 127.0.0.1:${PORT}."
    say "Open this in Chromium and pick a target:"
    say ""
    say "    http://127.0.0.1:${PORT}/"
    say ""
    say "Note: WebKit allows one inspector session per page, so close any other"
    say "debugger holding the same tab. Ctrl-C here stops the bridge."
    say ""
    exec pymobiledevice3 webinspector cdp
    ;;

  *)
    say "unknown command: $CMD"
    say "usage: scripts/ios-debug.sh [check|tabs|cdp]"
    exit 2
    ;;
esac
