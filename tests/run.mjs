#!/usr/bin/env node
//
// Checks that can run without a phone.
//
// Most of this project can only be verified on a device, which makes the few things that
// can be checked here worth checking every time: the script parses, the two version fields
// agree, the metadata is intact, and the guards that could break playback are still there.
//
// These are source-level assertions rather than behavioural tests. Running the real code
// would mean evaluating it here, which is not worth the hazard for a handful of checks -
// so where behaviour matters, the test asserts that the guard is present rather than
// exercising it. That catches the regression worth catching: someone removing it.
//
// Usage: node tests/run.mjs        (exit 0 = all passed)

import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = join(ROOT, 'youtube-declutter.user.js')
const src = readFileSync(SCRIPT, 'utf8')

let failed = 0
const check = (name, fn) => {
  try {
    const detail = fn()
    console.log(`  PASS  ${name}${detail ? ` - ${detail}` : ''}`)
  } catch (e) {
    failed++
    console.log(`  FAIL  ${name} - ${e.message}`)
  }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg) }

console.log('youtube-declutter checks\n')

check('script parses', () => {
  execFileSync(process.execPath, ['--check', SCRIPT], { stdio: 'pipe' })
  return `${src.length} chars`
})

check('version fields agree', () => {
  const meta = src.match(/^\/\/ @version\s+(\S+)/m)?.[1]
  const code = src.match(/const VERSION = '([^']+)'/)?.[1]
  assert(meta, 'no @version in the metadata block')
  assert(code, 'no const VERSION')
  assert(meta === code, `@version ${meta} but const VERSION ${code}`)
  return meta
})

check('metadata block is complete', () => {
  for (const field of ['@name', '@version', '@description', '@license', '@match', '@grant', '@run-at']) {
    assert(new RegExp(`^// ${field}\\b`, 'm').test(src), `missing ${field}`)
  }
  assert(/^\/\/ ==UserScript==/m.test(src), 'no opening ==UserScript==')
  assert(/^\/\/ ==\/UserScript==/m.test(src), 'no closing ==/UserScript==')
  return 'all required fields present'
})

check('innerHTML always goes through the Trusted Types helper', () => {
  // YouTube rejects a raw assignment, and the throw cascades: Stay abandons its page-world
  // injection and the page reload-loops. Worth failing a build over.
  const raw = src.split('\n')
    .map((line, i) => [i + 1, line])
    .filter(([, l]) => /\.innerHTML\s*=/.test(l) && !/htmlPolicy \? htmlPolicy\.createHTML/.test(l))
  assert(raw.length === 0, `raw innerHTML at line(s) ${raw.map(([n]) => n).join(', ')}`)
  return 'no raw assignments'
})

check('isMainPlayer still fails safe', () => {
  // If this predicate ever answers "not the main player" for something unexpected, the
  // preview feature pauses the video the user is watching. Both escape hatches must stay.
  const pred = src.match(/const isMainPlayer = \(v\) => \{[\s\S]*?\};\n/)?.[0]
  assert(pred, 'isMainPlayer is gone or was reshaped')
  assert(/catch \(e\) \{ return true; \}/.test(pred), 'the catch no longer returns true')
  assert(/!v\.closest \|\|/.test(pred), 'a node without closest() is no longer treated as the main player')
  const hosts = src.match(/const PLAYER_HOSTS = ([\s\S]*?);\n/)?.[1] ?? ''
  for (const sel of ['#movie_player', 'ytm-player', '.html5-video-player']) {
    assert(hosts.includes(sel), `PLAYER_HOSTS no longer covers ${sel}`)
  }
  return 'both fail-safes and the core selectors present'
})

check('preview suppression cannot touch the main player', () => {
  const fn = src.match(/const stopPreview = \(v\) => \{[\s\S]*?\n  \};/)?.[0]
  assert(fn, 'stopPreview is gone or was reshaped')
  assert(/if \(isMainPlayer\(v\)\) return;/.test(fn), 'the main-player guard is missing')
  assert(/if \(!S\.features\.stopPreviews/.test(fn), 'it no longer respects the feature flag')
  // Without this, a miniplayer the user is listening to could be paused.
  assert(/if \(!v\.muted\) return;/.test(fn), 'it can now pause audible video')
  return 'flag, main-player and muted guards present'
})

check('every feature flag has settings copy', () => {
  // A flag with no FEATURE_INFO entry never renders a row, so it cannot be turned on.
  const defaults = src.match(/features: \{([\s\S]*?)\},/)?.[1]
  assert(defaults, 'could not find the features block')
  const flags = [...defaults.matchAll(/^\s*(\w+):/gm)].map((m) => m[1]).filter((f) => f !== 'feedMode')
  const info = src.match(/const FEATURE_INFO = \{([\s\S]*?)\n  \};/)?.[1] ?? ''
  const missing = flags.filter((f) => !new RegExp(`^\\s*${f}:`, 'm').test(info))
  assert(missing.length === 0, `no FEATURE_INFO for: ${missing.join(', ')}`)
  return `${flags.length} flags`
})

check('the run-once guard uses the DOM, not window', () => {
  // Stay can inject twice into separate JavaScript contexts, which share only the DOM.
  assert(/document\.documentElement\.hasAttribute\(RAN\)/.test(src), 'the DOM marker guard is gone')
  return 'data-ytdc marker'
})

console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)
