## Knowledge base: plans, trackers, sessions, docs (MANDATORY)

**All working knowledge lives in `.workspace/`, which is its own git repository.** Read
`.workspace/README.md` before writing anything there.

There are **four artifact types**, and picking the right one is the point:

| Type | Answers | Where | Lifecycle |
|---|---|---|---|
| **plan** | "how will this be built?" | `.workspace/plans/<epic>/` | frozen once work starts; corrections go in an *Implementation notes* footer |
| **tracker** | "where is this epic up to?" | `.workspace/trackers/<epic>.md` | **updated in the same turn as the work it tracks** |
| **session** | "what was I doing when I stopped?" | `.workspace/sessions/` | write-once; archived on resume |
| **doc** | "how does this work / what did we find?" | `.workspace/docs/` | reference; superseded, not updated |

**The test:** if a file has checkboxes or a per-item status column, it is a **tracker**, not a
plan. To find out where something is up to, read the tracker, not the plans.

- **Every file needs frontmatter** (`type`, `status`, `updated`, `scope`, optional `epic` /
  `blocked-on` / `superseded-by`). A file without it is invisible to the index, so this is
  enforced, not advisory.
- **After any change, run `python3 .workspace/bin/build-index.py`** to regenerate
  `INDEX.md`. Use `--check` to validate: it fails on a stale `active` file, an epic tracker
  older than its newest child plan, and `blocked` with no `blocked-on:`.
- **When you finish work, update the epic's tracker in the same turn.** A tracker that lags
  behind the code is worse than no tracker, because it is believed.
- **Park a session with `/park`** rather than leaving state in your head or at the repo root.
- Do not leave a plan only in `~/.claude/plans/` - that directory is harness-managed and its
  auto-generated filenames (`cheeky-bubbling-conway.md`) make plans unfindable weeks later.
  When plan mode writes a plan there, **copy it into `.workspace/plans/` under a real
  name** as the final step, before reporting the plan as done.
- **Name the file for its content**, kebab-case, no timestamp prefix and no generated words.
  The name should tell a reader what it is about without opening it.
- **Never write a plan into a product repository.** A plan touching several repos has no
  correct single home, and notes paths are often gitignored - so a plan written there reads as
  saved while being effectively discarded.
- **Update rather than duplicate.** If a file for this work already exists, edit it and bump
  `updated:` and `status:` instead of writing a second one.

Done and abandoned work moves to an `archive/` directory rather than being deleted. Abandoned
plans keep `status: abandoned` and one line on why: a dead plan that *looks* live is an
expensive trap, and the file is the warning.
