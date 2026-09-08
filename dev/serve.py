#!/usr/bin/env python3
"""Serve the working copy of the userscript to the phone, so editing replaces pasting.

THE PROBLEM THIS SOLVES
-----------------------
Reading the device console is solved (scripts/ios-log.mjs). Getting *new code* onto the
phone was not: every change meant copy/pasting the whole file into Stay. This serves the
file over the network and a tiny loader on the phone re-fetches it on every page load, so
the loop becomes: save on the laptop, reload the page on the phone.

WHY NOT INJECT OVER THE DEBUG BRIDGE
------------------------------------
It would need no server at all, but there is no way to do it. CDP's
Page.addScriptToEvaluateOnNewDocument is a stub in pymobiledevice3's bridge - it records
the world name, returns an identifier and never injects the script - and WebKit's own
Page.setBootstrapScript is not forwarded (verified: the call times out). Anything evaluated
after load misses @run-at document-start, which this script depends on.

THE LOADER IS GENERATED, NOT EDITED
-----------------------------------
/loader.user.js is built per request with the host the phone actually used baked into it.
That removes the usual failure of this setup: a hardcoded LAN IP that is wrong, or right
until DHCP moves. Open http://<this-machine>:8787/ on the phone and tap the link.

MIXED CONTENT
-------------
YouTube is HTTPS, so a page-context fetch to a plain-HTTP address is blocked. The loader
uses GM_xmlhttpRequest, which the userscript manager performs outside the page, sidestepping
both mixed content and CORS. If a manager will not do that, serve over HTTPS with a
certificate the phone trusts (mkcert) and the loader's plain-fetch fallback takes over.

Usage:  dev/serve.py [--port 8787] [--file youtube-declutter.user.js]
"""

import argparse
import datetime
import json
import os
import socket
import zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOG_DIR = os.path.join(ROOT, "dev", "logs")

LOADER_TEMPLATE = """// ==UserScript==
// @name         YouTube Declutter (dev loader)
// @namespace    local.yt-declutter
// @version      {version}
// @description  Loads the working copy from {host} on every page load. Development only.
// @author       JackMBurch
// @license      MIT
// @copyright    2026, Jack Burch
// @match        https://www.youtube.com/*
// @match        https://m.youtube.com/*
// @match        https://youtube.com/*
// @grant        GM_xmlhttpRequest
// @connect      {connect}
// @run-at       document-start
// @updateURL    {base}/loader.user.js
// @downloadURL  {base}/loader.user.js
// ==/UserScript==

// Install this ONCE. It has no features of its own: it fetches the working copy from the
// dev machine and runs it, so a save on the laptop plus a page reload on the phone is the
// whole edit cycle.
//
// Disable the released YouTube Declutter script while this is installed, or both run and
// each will install its own observers over the same DOM.

(function () {{
  'use strict';

  var TAG = '[ytdc-loader]';

  // Stay runs this twice per load on iOS - its own console output says so. Fetching and
  // evaluating the script twice is worth avoiding on its own; the script guards itself as
  // well, but doing it here saves a second request and a second parse of 50KB.
  if (window.__ytdcLoader) {{ console.info(TAG, 'already loaded; second copy stood down'); return; }}
  window.__ytdcLoader = true;

  var SRC = '{base}/{file}';

  // YouTube serves require-trusted-types-for 'script', so eval() refuses a plain string:
  // "Refused to evaluate a string as JavaScript because this document requires a 'Trusted
  // Type' assignment". A policy whose createScript returns the source unchanged satisfies
  // that. Creating one is permitted on this document (probed on the device), and the page
  // itself uses the same mechanism. Named and cached, because createPolicy throws if the
  // same name is registered twice in one document.
  function asTrustedScript(code) {{
    try {{
      if (window.trustedTypes && window.trustedTypes.createPolicy) {{
        if (!window.__ytdcPolicy) {{
          window.__ytdcPolicy = window.trustedTypes.createPolicy(
            'ytdc-dev', {{ createScript: function (s) {{ return s; }} }});
        }}
        return window.__ytdcPolicy.createScript(code);
      }}
    }} catch (e) {{
      console.warn(TAG, 'no Trusted Types policy (' + (e && e.message) + '); trying raw');
    }}
    return code;
  }}

  function run(code, how) {{
    try {{
      // Indirect eval, so the script evaluates in global scope exactly as a userscript
      // manager would run it, rather than inside this function's closure.
      (0, eval)(asTrustedScript(code));
      window.__ytdcLoaded = {{ at: new Date().toISOString(), chars: code.length, via: how }};
      console.info(TAG, 'loaded', code.length, 'chars via', how);
    }} catch (e) {{
      console.error(TAG, 'the script threw while starting:', e && e.message, e);
    }}
  }}

  function fallbackFetch() {{
    // Only reachable when the dev server is HTTPS with a trusted certificate; over plain
    // HTTP the page blocks this as mixed content. Kept so the mkcert path needs no edit.
    fetch(SRC, {{ cache: 'no-store' }})
      .then(function (r) {{ return r.text(); }})
      .then(function (code) {{ run(code, 'fetch'); }})
      .catch(function (e) {{
        console.error(TAG, 'could not reach ' + SRC + '.',
          'Is dev/serve.py running, and is the phone on the same network?', e && e.message);
      }});
  }}

  if (typeof GM_xmlhttpRequest === 'function') {{
    GM_xmlhttpRequest({{
      method: 'GET',
      url: SRC,
      headers: {{ 'Cache-Control': 'no-cache' }},
      onload: function (res) {{
        if (res.status >= 200 && res.status < 300) run(res.responseText, 'GM_xmlhttpRequest');
        else console.error(TAG, 'server returned', res.status);
      }},
      onerror: function () {{
        console.warn(TAG, 'GM_xmlhttpRequest failed; trying fetch');
        fallbackFetch();
      }}
    }});
  }} else {{
    console.warn(TAG, 'no GM_xmlhttpRequest; trying fetch (blocked over plain HTTP)');
    fallbackFetch();
  }}
}})();
"""

# Rendered with str.replace rather than str.format: the page carries JavaScript, and
# doubling every brace to survive format() makes it unreadable and easy to break.
INDEX = """<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>YouTube Declutter dev server</title>
<style>
  body { font: 16px/1.5 -apple-system, system-ui, sans-serif; margin: 0 auto; max-width: 34rem;
         padding: 1.5rem 1rem 4rem; }
  h2 { margin-top: 2.2rem; font-size: 1.05rem; }
  .btn { display: block; width: 100%; padding: 1rem; background: #1a73e8; color: #fff;
         border: 0; border-radius: 8px; text-align: center; font: 600 16px inherit;
         margin: 1rem 0 .5rem; text-decoration: none; -webkit-appearance: none; }
  .btn.alt { background: #444; }
  code { background: #f1f1f1; padding: .15em .4em; border-radius: 4px; }
  .url { background: #f1f1f1; padding: .8rem; border-radius: 8px; word-break: break-all;
         font-family: ui-monospace, monospace; user-select: all; -webkit-user-select: all; }
  textarea { width: 100%; height: 9rem; font: 11px ui-monospace, monospace; margin-top: .5rem;
             border: 1px solid #ccc; border-radius: 8px; padding: .5rem; }
  .hint { font-size: .85rem; opacity: .7; }
  .sep { border: 0; border-top: 1px solid #ddd; margin: 2.5rem 0 0; }
</style>
<h1>YouTube Declutter</h1>
<p>Serving <code>__FILE__</code>, __SIZE__ characters.</p>

<h2>1. Live reload, for debugging</h2>
<p>Install once. Every page load pulls the current file from this machine, so editing here
is all it takes. Stay has no install prompt for a link, so import by URL:
Stay &rarr; <em>+</em> &rarr; <em>Link</em>.</p>
<div class="url" id="u">__BASE__/loader.user.js</div>
<button class="btn" onclick="copyEl(document.getElementById('u'), this)">Copy the URL</button>

<h2>2. Plain copy, for when you are not debugging</h2>
<p>Copies the whole script. Paste it into Stay as its own script
(<em>+</em> &rarr; <em>Write script</em>), and it runs with no dev server and no laptop.</p>
<button class="btn alt" onclick="copyScript(this)">Copy the script</button>
<p class="hint">If the button cannot reach the clipboard, the text appears below - long-press
it, Select All, Copy. Safari blocks the clipboard API on plain HTTP, so that happens.</p>
<textarea id="src" hidden readonly>__SCRIPT__</textarea>
<p><a href="/__FILE__">View the raw script</a></p>

<hr class="sep">
<p class="hint">Only run one of them at a time. Two copies fight over the same DOM.</p>

<script>
function flash(btn, msg) { var t = btn.textContent; btn.textContent = msg;
  setTimeout(function () { btn.textContent = t; }, 1800); }

// iOS will not select inside a readonly field, and execCommand needs a live selection.
function selectAll(el) {
  el.removeAttribute('readonly');
  var range = document.createRange();
  range.selectNodeContents(el);
  var sel = window.getSelection();
  sel.removeAllRanges(); sel.addRange(range);
  if (el.setSelectionRange) el.setSelectionRange(0, el.value.length);
  el.setAttribute('readonly', '');
}

function copyText(text, el, btn) {
  var done = false;
  if (el) { el.hidden = false; el.focus(); selectAll(el); }
  try { done = document.execCommand('copy'); } catch (e) { done = false; }
  if (done) { flash(btn, 'Copied'); if (el) el.hidden = true; return; }
  // Secure-context only, so usually absent here - tried second, not first.
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(
      function () { flash(btn, 'Copied'); if (el) el.hidden = true; },
      function () { flash(btn, 'Copy it by hand'); });
    return;
  }
  flash(btn, 'Copy it by hand');
}

function copyEl(node, btn) { copyText(node.textContent.trim(), null, btn); }
function copyScript(btn) { var ta = document.getElementById('src'); copyText(ta.value, ta, btn); }
</script>
"""


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _send(self, body: bytes, content_type: str, status: int = 200) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        # Without this the manager and WebKit both cache, and the whole point is lost.
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        host = self.headers.get("Host") or f"{self.server.server_address[0]}:{self.server.server_address[1]}"
        base = f"http://{host}"
        path = self.path.split("?", 1)[0]

        if path == "/":
            try:
                with open(os.path.join(ROOT, self.server.script_name)) as fh:
                    source = fh.read()
            except OSError:
                source = "// could not read " + self.server.script_name
            # Escaped so the script's own markup cannot end the textarea early.
            escaped = source.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
            page = (INDEX
                    .replace("__FILE__", self.server.script_name)
                    .replace("__BASE__", base)
                    .replace("__SIZE__", str(len(source)))
                    .replace("__SCRIPT__", escaped))
            self._send(page.encode(), "text/html; charset=utf-8")
        elif path == "/loader.user.js":
            # A version that changes every start, so the manager sees an update rather than
            # silently keeping the copy it already has.
            fields = dict(host=host, connect=host.split(":")[0], base=base,
                          file=self.server.script_name)
            digest = zlib.crc32(LOADER_TEMPLATE.format(version="0", **fields).encode()) % 100000
            loader = LOADER_TEMPLATE.format(version=f"1.0.{digest}", **fields)
            self._send(loader.encode(), "text/javascript; charset=utf-8")
        elif path == f"/{self.server.script_name}":
            try:
                with open(os.path.join(ROOT, self.server.script_name), "rb") as fh:
                    self._send(fh.read(), "text/javascript; charset=utf-8")
            except OSError as exc:
                self._send(f"cannot read {self.server.script_name}: {exc}".encode(), "text/plain", 500)
        else:
            self._send(b"not found", "text/plain", 404)

    def do_POST(self) -> None:  # noqa: N802
        if self.path.split("?", 1)[0] != "/log":
            self._send(b"not found", "text/plain", 404)
            return
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length).decode("utf-8", "replace")
        stamped = json.dumps({"ts": datetime.datetime.now().isoformat(timespec="seconds"), "raw": raw})
        os.makedirs(LOG_DIR, exist_ok=True)
        with open(os.path.join(LOG_DIR, "device.jsonl"), "a") as fh:
            fh.write(stamped + "\n")
        print(f"  device: {raw[:300]}", flush=True)
        self._send(b"ok", "text/plain")

    def log_message(self, fmt: str, *args) -> None:
        # One useful line per request instead of the default two-line noise.
        print(f"  {self.address_string()} {fmt % args}", flush=True)


def candidate_addresses(port: int) -> list[str]:
    """Every address the phone might reach this machine on, USB first.

    Plugging the phone in raises an `ipheth` interface, a direct link to the phone that
    works with no WiFi and no shared network. It is usually the more reliable of the two,
    and the default-route trick never finds it, so enumerate interfaces properly and put
    that one first. Falls back to hostname resolution where `ip` is unavailable.
    """
    import subprocess

    usb: list[str] = []
    lan: list[str] = []
    try:
        out = subprocess.run(
            ["ip", "-4", "-o", "addr", "show", "scope", "global"],
            capture_output=True, text=True, timeout=5,
        ).stdout
        for line in out.splitlines():
            parts = line.split()
            if len(parts) < 4:
                continue
            iface, ip = parts[1], parts[3].split("/")[0]
            if ip.startswith("127."):
                continue
            driver = os.path.realpath(f"/sys/class/net/{iface}/device/driver")
            (usb if os.path.basename(driver) == "ipheth" else lan).append((iface, ip))
    except (OSError, subprocess.SubprocessError):
        pass

    urls = [f"http://{ip}:{port}/   ({iface}, USB to the phone)" for iface, ip in usb]
    urls += [f"http://{ip}:{port}/   ({iface})" for iface, ip in lan]

    if not urls:
        try:
            probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            probe.connect(("8.8.8.8", 80))
            urls.append(f"http://{probe.getsockname()[0]}:{port}/")
            probe.close()
        except OSError:
            pass
    return urls


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8787)
    parser.add_argument("--file", default="youtube-declutter.user.js")
    args = parser.parse_args()

    if not os.path.exists(os.path.join(ROOT, args.file)):
        print(f"no such file: {args.file}")
        return 1

    server = ThreadingHTTPServer(("0.0.0.0", args.port), Handler)
    server.script_name = args.file
    server.loader_version = datetime.datetime.now().strftime("%Y.%m.%d.%H%M%S")

    print(f"Serving {args.file} on port {args.port}.", flush=True)
    print("Open one of these on the phone and tap Install:", flush=True)
    for url in candidate_addresses(args.port) or [f"http://<this-machine>:{args.port}/"]:
        print(f"    {url}", flush=True)
    print("\nDisable the released script in your manager while the loader is installed.", flush=True)
    print("Ctrl-C to stop.\n", flush=True)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
