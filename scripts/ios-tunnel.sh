#!/usr/bin/env bash
#
# Expose the host's CDP bridge inside an agent sandbox.
#
# An agent working in this repo runs in a network namespace holding only `lo` and no
# routes, so the bridge started by `ios-debug.sh cdp` on the host is unreachable to it -
# the sandbox's 127.0.0.1 is its own, not the host's. The sandbox does have an HTTP proxy
# that runs outside the namespace, so a CONNECT through that proxy lands on the host's
# loopback. This forwards a local port through it, which lets `ios-log.mjs` speak plain
# TCP and WebSocket without knowing any of that.
#
# Deliberate design choice: forward to a *different* local port rather than making
# 127.0.0.1 proxied globally. Routing all loopback traffic through the proxy would shadow
# the sandbox's own local servers with the host's, which breaks running a local test
# server - the thing this repo's tests rely on.
#
# This is sanctioned by policy, not a way around it: the host's loopback must be listed in
#
#   {"sandbox": {"network": {"allowedDomains": ["127.0.0.1", "localhost", "[::1]"]}}}
#
# which is the list the proxy enforces. What it works around is only the client-side
# default: NO_PROXY lists localhost, so clients bypass the proxy and hit the sandbox's own
# loopback. Setting NO_PROXY through the settings `env` block does NOT help - the sandbox
# sets its own value over it, verified 2026-09-07. socat is used rather than a proxy-aware
# HTTP client because Node's fetch and WebSocket ignore the proxy environment entirely.
#
# Usage:
#   scripts/ios-tunnel.sh [host-port] [local-port]     defaults: 9223 -> 19223
#
# Then:  scripts/ios-log.mjs --port 19223
#
# Outside a sandbox this is unnecessary: talk to the bridge directly.

set -euo pipefail

HOST_PORT="${1:-9223}"
LOCAL_PORT="${2:-19223}"

command -v socat >/dev/null 2>&1 || { echo "socat is required but not installed" >&2; exit 1; }

PROXY_URL="${HTTP_PROXY:-${http_proxy:-}}"
if [ -z "$PROXY_URL" ]; then
  echo "No HTTP_PROXY set. This script is only meaningful inside a sandbox that has one;" >&2
  echo "outside one, connect to 127.0.0.1:$HOST_PORT directly." >&2
  exit 1
fi

# http://user:pass@host:port -> parts. Credentials are session-scoped and come from the
# environment; they are never written anywhere by this script.
strip="${PROXY_URL#*://}"
creds=""
case "$strip" in
  *@*) creds="${strip%@*}"; strip="${strip##*@}" ;;
esac
proxy_host="${strip%%:*}"
proxy_port="${strip##*:}"

opts="proxyport=${proxy_port}"
[ -n "$creds" ] && opts="${opts},proxyauth=${creds}"

echo "Forwarding 127.0.0.1:${LOCAL_PORT} -> (proxy ${proxy_host}:${proxy_port}) -> host 127.0.0.1:${HOST_PORT}"
echo "Now run:  scripts/ios-log.mjs --port ${LOCAL_PORT}"
echo "Ctrl-C to stop."

exec socat "TCP-LISTEN:${LOCAL_PORT},fork,reuseaddr,bind=127.0.0.1" \
           "PROXY:${proxy_host}:127.0.0.1:${HOST_PORT},${opts}"
