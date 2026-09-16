---
name: park
description: Park the current session - write a resumable handoff to the workspace sessions directory capturing what was being done, the exact branch and commit state, what is verified vs assumed, and the precise next step. Use when stopping mid-task, at the end of a working session, before a context switch, or when asked to park/pause/hand off/write a handoff.
---

# Park a session

Write the state a fresh session would otherwise have to reconstruct, and usually gets wrong.

The failure this prevents: handoff notes written at a project root, or not written at all,
because there was nowhere to put them and nothing prompting them.

## When to use

- Stopping mid-task with real work in flight
- End of a working session
- Before a context switch to an unrelated epic
- When asked to park, pause, hand off, or "write this up before I stop"

**Not** for finished work. If the work is done and merged, update the epic tracker instead. A
session file for completed work is noise in `sessions/`.

## Steps

### 1. Gather the state, do not write from memory

Run the commands and use the real output. A guessed branch or commit is the single most
damaging thing a handoff can contain, because the next session trusts it.

Read `<WORKSPACE_DIR>/config.toml` for the layout, then:

**Multi-repo** - each sibling directory that is a git repository:

```
for r in <WORKSPACE_DIR>/../*/; do
  [ -d "$r/.git" ] || continue
  echo "== $r"; git -C "$r" status -sb | head -20; git -C "$r" log --oneline -5
done
```

**Monorepo** - one repository; report the branch once and scope changes by package:

```
git status -sb | head -30
git log --oneline -5
git diff --stat HEAD | tail -20
```

Note for each: current branch, its base, uncommitted changes, unpushed commits, open PRs.

### 2. Write the file

Path: `<WORKSPACE_DIR>/sessions/<YYYY-MM-DD>-<slug>.md`, where `<slug>` names the work
(`checkout-payment-intents`, not `session-3`). Start from
`<WORKSPACE_DIR>/templates/session.md`.

If `config.toml` lists `subworkspaces` and the parked work belongs to one of those
sub-projects alone, write it under that sub-workspace instead:
`<WORKSPACE_DIR>/<sub-project path>/sessions/`. From inside the sub-project the plain
`<WORKSPACE_DIR>/sessions/` path already resolves there through the symlink, so the only case
that needs care is parking sub-project work from the project root.

The two sections that carry the value:

- **The exact next step.** One concrete action - the actual next command, file or decision.
  Not "continue the work". If you cannot name it, you have not finished parking.
- **Verified vs assumed.** Kept apart deliberately. A fresh session cannot tell the difference
  from the outside and will treat both as fact.

### 3. Update the index and the tracker

```
python3 <WORKSPACE_DIR>/bin/build-index.py
```

If the parked work belongs to an epic, update that epic's tracker in the same turn. Parking is
work stopping, which is exactly when a tracker most often goes stale.

## On resume

Read the session file, act on it, then move it to `<WORKSPACE_DIR>/sessions/archive/` and set
`status: done`. A resumed session left in place will be read again by the next session and
believed a second time.
