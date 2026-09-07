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

# Resolve pymobiledevice3 without depending on the shell's PATH.
#
# pipx installs each application into its own venv and drops the entrypoint in
# ~/.local/bin, which is not on PATH on every machine - so "installed" and "resolves by
# name" are different states, and the gap between them looks exactly like a missing
# install. Check the likely locations rather than making the caller fix their profile.
# Set PMD3 to override, which is also the escape hatch if it lives in a project venv.
find_pmd3() {
  if [ -n "${PMD3:-}" ]; then printf '%s\n' "$PMD3"; return; fi
  if command -v pymobiledevice3 >/dev/null 2>&1; then command -v pymobiledevice3; return; fi
  for c in "$HOME/.local/bin/pymobiledevice3" \
           "$HOME/.local/share/pipx/venvs/pymobiledevice3/bin/pymobiledevice3"; do
    [ -x "$c" ] && { printf '%s\n' "$c"; return; }
  done
  return 1
}

say "Checking the chain from this machine to the phone."
say ""

# 1. The bridge itself.
if PMD3_BIN="$(find_pmd3)"; then
  ok "pymobiledevice3 $("$PMD3_BIN" version 2>/dev/null || echo '(version unknown)')"
  case ":$PATH:" in
    *":$(dirname "$PMD3_BIN"):"*) ;;
    *) note "found at $PMD3_BIN, which is not on PATH - run 'pipx ensurepath' to fix the bare name" ;;
  esac
else
  bad "pymobiledevice3 not installed"
  note "sudo pacman -S --needed python-pipx && pipx install pymobiledevice3"
  fail=1
fi

# 2. Is an Apple device physically on the bus? Ask sysfs rather than libimobiledevice.
#    The libimobiledevice tools need usbmuxd to answer, and usbmuxd is not running until a
#    device is attached, so asking them first conflates "nothing plugged in" with "daemon
#    down". Reading the USB tree directly breaks that circle. 05ac is Apple's vendor id.
apple_usb=0
for v in /sys/bus/usb/devices/*/idVendor; do
  [ -r "$v" ] || continue
  if [ "$(cat "$v" 2>/dev/null)" = "05ac" ]; then apple_usb=1; break; fi
done

if [ "$apple_usb" -eq 1 ]; then
  ok "Apple device present on the USB bus"
else
  bad "no Apple device on the USB bus"
  note "plug the phone in over USB and unlock it"
  fail=1
fi

# 3. usbmuxd carries every message to the device. On Arch this unit has no [Install]
#    section: udev starts it when an Apple device appears (39-usbmuxd.rules) and stops it
#    when the last one is removed. So "inactive with nothing plugged in" is correct rather
#    than broken, and `systemctl enable` fails outright on a unit with no install config.
#    Only treat it as a fault when a device is attached and it still is not running.
if systemctl is-active --quiet usbmuxd 2>/dev/null; then
  ok "usbmuxd running"
elif [ "$apple_usb" -eq 1 ]; then
  bad "device attached but usbmuxd is not running"
  note "sudo systemctl start usbmuxd   (start, not enable: the unit has no [Install] section)"
  fail=1
else
  note "usbmuxd idle, which is expected with nothing plugged in - udev starts it on attach"
fi

# 4. Whether this host is trusted by the device. An attached-but-untrusted phone otherwise
#    looks identical to an absent one.
if command -v idevice_id >/dev/null 2>&1; then
  udids="$(idevice_id -l 2>/dev/null || true)"
  if [ -n "$udids" ]; then
    ok "usbmuxd sees: $(echo "$udids" | tr '\n' ' ')"
    if idevicepair validate >/dev/null 2>&1; then
      ok "host is paired and trusted"
    else
      bad "device visible but this host is not trusted"
      note "run: idevicepair pair    then unlock the phone, tap Trust, and re-run"
      fail=1
    fi
  elif [ "$apple_usb" -eq 1 ]; then
    bad "device is on the bus but usbmuxd cannot see it"
    note "unlock the phone and tap Trust if prompted, then re-run"
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
    "$PMD3_BIN" webinspector opened-tabs || {
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
    exec "$PMD3_BIN" webinspector cdp
    ;;

  *)
    say "unknown command: $CMD"
    say "usage: scripts/ios-debug.sh [check|tabs|cdp]"
    exit 2
    ;;
esac
