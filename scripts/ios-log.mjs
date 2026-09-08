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
//   --cmd-dir directory watched for *.js to evaluate on the page. Default: dev/cmd
//   --no-cmd  disable the command channel (logs only)
//
// The command channel closes the loop. A sandboxed agent cannot reach the bridge, but it can
// write a file: drop `foo.js` into dev/cmd/, it is evaluated in the page, the result is
// appended to dev/logs/results.jsonl, and the input is renamed to foo.js.done so it runs
// once. That makes the whole edit/observe/probe cycle reachable through the filesystem.

import { appendFile, mkdir, stat, rename, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve, join } from 'node:path'

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
const CMD_DIR = resolve(flag('cmd-dir', 'dev/cmd'))
const RESULTS = resolve(flag('results', 'dev/logs/results.jsonl'))
const CMD_ON = !has('no-cmd')

// Rotate rather than grow without bound. A long session on a page that logs in a loop can
// produce a lot, and an unreadable 500MB file helps nobody.
const MAX_BYTES = 8 * 1024 * 1024

const attached = new Map() // targetId -> WebSocket
const pending = new Map()  // CDP message id -> resolver for that reply
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

function attach (target, port) {
  // /json reports the bridge's own view of its address. When this process reached the
  // bridge somewhere else - a forwarded port, a tunnel - that host:port does not resolve
  // here, so point the socket at the endpoint we actually got an answer from.
  const wsUrl = String(target.webSocketDebuggerUrl).replace(
    /^ws:\/\/[^/]+/, `ws://127.0.0.1:${port}`)
  const ws = new WebSocket(wsUrl)
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

    if (msg.id !== undefined && pending.has(msg.id)) {
      const resolve_ = pending.get(msg.id)
      pending.delete(msg.id)
      resolve_(msg)
      return
    }

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

function evaluate (ws, expression) {
  // awaitPromise so an async probe can be written naturally; returnByValue so the result
  // arrives as data rather than a handle this process would have to dereference.
  const id = nextId++
  const done = new Promise((res) => pending.set(id, res))
  ws.send(JSON.stringify({
    id,
    method: 'Runtime.evaluate',
    params: { expression, awaitPromise: true, returnByValue: true, allowUnsafeEvalBlockedByCSP: true }
  }))
  return Promise.race([
    done,
    new Promise((res) => setTimeout(() => { pending.delete(id); res({ error: { message: 'timed out after 15s' } }) }, 15000))
  ])
}

async function runCommands () {
  if (!CMD_ON) return
  let names = []
  try {
    await mkdir(CMD_DIR, { recursive: true })
    names = (await readdir(CMD_DIR)).filter((n) => n.endsWith('.js')).sort()
  } catch { return }
  if (!names.length) return

  const ws = [...attached.values()].find((w) => w.readyState === 1)
  if (!ws) return // nothing attached yet; leave the file for the next pass

  for (const name of names) {
    const path = join(CMD_DIR, name)
    let source
    try { source = await readFile(path, 'utf8') } catch { continue }

    // Rename before running, not after: a command that reloads the page or crashes the tab
    // must not be picked up again on the next pass and run forever.
    try { await rename(path, `${path}.done`) } catch { continue }

    const reply = await evaluate(ws, source)
    const d = reply.result ?? {}
    const failed = reply.error ?? d.exceptionDetails
    const record = {
      ts: now(),
      cmd: name,
      ok: !failed,
      value: failed ? undefined : d.result?.value ?? d.result?.description,
      error: failed
        ? (reply.error?.message ?? d.exceptionDetails?.exception?.description ?? d.exceptionDetails?.text)
        : undefined
    }
    try {
      await mkdir(dirname(RESULTS), { recursive: true })
      await appendFile(RESULTS, JSON.stringify(record) + '\n')
    } catch { /* reported below regardless */ }
    write({
      kind: 'command',
      level: record.ok ? 'meta' : 'error',
      text: `${name} -> ${record.ok ? JSON.stringify(record.value) : record.error}`
    })
  }
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
      if (CMD_ON) console.error(`command channel: drop *.js in ${CMD_DIR}, results -> ${RESULTS}`)
    }

    try {
      const targets = await listTargets(port)
      for (const t of targets) {
        if (t.type !== 'page' && t.type !== 'webview') continue
        if (!t.webSocketDebuggerUrl) continue
        if (FILTER && !String(t.url).includes(FILTER)) continue
        if (attached.has(t.id)) continue
        attach(t, port)
      }
    } catch {
      // The bridge went away, or the phone did. Re-probe rather than dying: an unattended
      // loop should survive a cable being nudged.
      if (ONCE) { console.error('bridge went away'); process.exit(1) }
      port = null
      for (const ws of attached.values()) { try { ws.close() } catch {} }
      attached.clear()
    }

    await runCommands()

    // Re-scan: YouTube is a single-page app, but full navigations still make new targets.
    await new Promise((r) => setTimeout(r, 2000))
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
