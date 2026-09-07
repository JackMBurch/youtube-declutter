#!/usr/bin/env node
//
// Stream console output from the phone into a file on disk.
//
// Why a file rather than a socket: an agent working in this repo runs in a sandbox with its
// own network namespace, so it cannot reach the CDP bridge on loopback no matter which port
// is used. It can read files. Writing every console line, error and unhandled rejection to
// `dev/logs/console.jsonl` is therefore what makes an unattended edit-and-check loop
// possible: the code changes, the page reloads, and the evidence lands somewhere readable.
//
// Zero dependencies. Node 22 ships global `fetch` and `WebSocket`, which is the whole client.
//
// Usage:
//   scripts/ios-log.mjs [--port N] [--filter SUBSTR] [--out PATH] [--quiet] [--once]
//
//   --port    CDP bridge port. Default: probe 9222-9232 for one that answers.
//   --filter  only attach to targets whose URL contains this. Default: youtube
//   --out     JSONL output path. Default: dev/logs/console.jsonl
//   --quiet   do not echo to stdout (the file still gets everything)
//   --once    exit when the bridge goes away instead of waiting for it to come back

import { appendFile, mkdir, stat, rename } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i === -1 ? fallback : args[i + 1]
}
const has = (name) => args.includes(`--${name}`)

const FILTER = flag('filter', 'youtube')
const OUT = resolve(flag('out', 'dev/logs/console.jsonl'))
const QUIET = has('quiet')
const ONCE = has('once')
const FIXED_PORT = flag('port', null)

// Rotate rather than grow without bound. A long session on a page that logs in a loop can
// produce a lot, and an unreadable 500MB file helps nobody.
const MAX_BYTES = 8 * 1024 * 1024

const attached = new Map() // targetId -> WebSocket
let nextId = 1

const now = () => new Date().toISOString()

async function write (record) {
  const line = JSON.stringify({ ts: now(), ...record })
  if (!QUIET) {
    const where = record.url ? ` ${String(record.url).replace(/^https?:\/\//, '').slice(0, 40)}` : ''
    console.log(`[${record.level ?? record.kind}]${where} ${record.text ?? ''}`)
  }
  try {
    await mkdir(dirname(OUT), { recursive: true })
    try {
      const s = await stat(OUT)
      if (s.size > MAX_BYTES) await rename(OUT, `${OUT}.1`)
    } catch { /* no file yet */ }
    await appendFile(OUT, line + '\n')
  } catch (e) {
    if (!QUIET) console.error('could not write log:', e.message)
  }
}

// A RemoteObject is not a value. Strings carry `value`, objects carry a `preview` or only a
// `description`, and unserialisable things carry neither - so fall through rather than
// printing "undefined" for something that was really an object.
function renderArg (a) {
  if (!a) return ''
  if ('value' in a) return typeof a.value === 'string' ? a.value : JSON.stringify(a.value)
  if (a.preview?.properties) {
    const body = a.preview.properties.map((p) => `${p.name}: ${p.value}`).join(', ')
    return `${a.className ?? 'Object'}{${body}}`
  }
  return a.description ?? a.className ?? a.type ?? ''
}

function frameOf (stackTrace) {
  const f = stackTrace?.callFrames?.[0]
  if (!f) return undefined
  const where = f.url ? f.url.split('/').pop() : '<anonymous>'
  return `${f.functionName || '(anon)'} @ ${where}:${f.lineNumber + 1}`
}

async function probePort () {
  if (FIXED_PORT) return Number(FIXED_PORT)
  // The bridge steps past a busy 9222, so the port is not knowable up front.
  for (let p = 9222; p <= 9232; p++) {
    try {
      const r = await fetch(`http://127.0.0.1:${p}/json/version`, { signal: AbortSignal.timeout(700) })
      if (r.ok) return p
    } catch { /* not this one */ }
  }
  return null
}

async function listTargets (port) {
  const r = await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(4000) })
  if (!r.ok) throw new Error(`/json returned ${r.status}`)
  return await r.json()
}

function attach (target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  attached.set(target.id, ws)

  ws.addEventListener('open', () => {
    // Console.enable is the legacy domain and WebKit still reports some entries only there,
    // so enable all three rather than assuming Runtime covers everything.
    for (const method of ['Runtime.enable', 'Log.enable', 'Console.enable', 'Page.enable']) {
      ws.send(JSON.stringify({ id: nextId++, method }))
    }
    write({ kind: 'attached', level: 'meta', text: `attached to ${target.url}`, url: target.url })
  })

  ws.addEventListener('message', (ev) => {
    let msg
    try { msg = JSON.parse(ev.data) } catch { return }
    const p = msg.params ?? {}

    switch (msg.method) {
      case 'Runtime.consoleAPICalled':
        write({
          kind: 'console',
          level: p.type,
          text: (p.args ?? []).map(renderArg).join(' '),
          at: frameOf(p.stackTrace),
          url: target.url
        })
        break

      case 'Runtime.exceptionThrown': {
        const d = p.exceptionDetails ?? {}
        write({
          kind: 'exception',
          level: 'error',
          text: d.exception?.description ?? d.text ?? 'exception',
          at: frameOf(d.stackTrace),
          url: target.url
        })
        break
      }

      case 'Log.entryAdded':
        write({
          kind: 'log',
          level: p.entry?.level,
          text: p.entry?.text,
          at: p.entry?.url ? `${p.entry.url}:${p.entry.lineNumber ?? ''}` : undefined,
          url: target.url
        })
        break

      case 'Page.frameNavigated':
        if (!p.frame?.parentId) {
          write({ kind: 'navigated', level: 'meta', text: p.frame?.url, url: target.url })
        }
        break
    }
  })

  const drop = (why) => {
    if (attached.get(target.id) === ws) attached.delete(target.id)
    write({ kind: 'detached', level: 'meta', text: `${why}: ${target.url}`, url: target.url })
  }
  ws.addEventListener('close', () => drop('closed'))
  ws.addEventListener('error', () => drop('error'))
}

async function main () {
  let port = null
  let warnedNoBridge = false

  for (;;) {
    if (port === null) {
      port = await probePort()
      if (port === null) {
        if (ONCE) { console.error('no CDP bridge found on 9222-9232'); process.exit(1) }
        if (!warnedNoBridge) {
          console.error('waiting for the CDP bridge (scripts/ios-debug.sh cdp)...')
          warnedNoBridge = true
        }
        await new Promise((r) => setTimeout(r, 2000))
        continue
      }
      warnedNoBridge = false
      console.error(`collecting from 127.0.0.1:${port}, filter "${FILTER}" -> ${OUT}`)
    }

    try {
      const targets = await listTargets(port)
      for (const t of targets) {
        if (t.type !== 'page' && t.type !== 'webview') continue
        if (!t.webSocketDebuggerUrl) continue
        if (FILTER && !String(t.url).includes(FILTER)) continue
        if (attached.has(t.id)) continue
        attach(t)
      }
    } catch {
      // The bridge went away, or the phone did. Re-probe rather than dying: an unattended
      // loop should survive a cable being nudged.
      if (ONCE) { console.error('bridge went away'); process.exit(1) }
      port = null
      for (const ws of attached.values()) { try { ws.close() } catch {} }
      attached.clear()
    }

    // Re-scan: YouTube is a single-page app, but full navigations still make new targets.
    await new Promise((r) => setTimeout(r, 2000))
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
