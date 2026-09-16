#!/usr/bin/env bash
#
# Bump the version, and optionally publish it to Greasy Fork.
#
# The version lives twice - `@version` in the metadata block, which is what a userscript
# manager and Greasy Fork read, and `const VERSION`, which is what the script reports in
# its boot line and its debug sheet. They must agree. When they drift, the manager and the
# running script disagree about what is installed, and the debug output starts lying about
# which build produced it. This is the only thing that should write either of them.
#
# Usage:
#   scripts/release.sh patch|minor|major|X.Y.Z [--dry-run] [--tag] [--publish]
#   scripts/release.sh status
#
#   --dry-run   print what would change and touch nothing
#   --tag       also create an annotated git tag v<version>
#   --publish   push, move the `release` branch to this commit, and wait for Greasy Fork
#               to report the new version (implies --tag)
#   status      compare the version here, on the release branch, and on Greasy Fork
#
# HOW PUBLISHING WORKS
# Greasy Fork syncs the script from the `release` branch on GitHub, triggered by a webhook.
# The webhook fires on every push, but Greasy Fork only acts when the file at its sync URL
# changed - so pushing to master publishes nothing, and moving `release` publishes. That is
# the point: work can land on master without going out to everyone who installed it.
#
# Webhook sync is known to fail quietly, so --publish does not assume the push worked. It
# polls Greasy Fork until the new version appears, and says so plainly if it never does.

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

SCRIPT="youtube-declutter.user.js"
CHANGELOG="CHANGELOG.md"
RELEASE_BRANCH="release"
GF_META="${GF_META:-https://update.greasyfork.org/scripts/596100.meta.js}"
# Overridable so the publish path can be exercised against a fake Greasy Fork.
POLL_TRIES="${POLL_TRIES:-40}"
POLL_SECONDS="${POLL_SECONDS:-15}"
GF_PAGE="https://greasyfork.org/scripts/596100"

version_in() { grep -m1 '^// @version' | awk '{print $3}'; }

published_version() {
  # max-age=0 on this endpoint, but a query string keeps any intermediary honest.
  local url="$GF_META"
  case "$url" in http*) url="${url}?t=$(date +%s)" ;; esac
  curl -fsS -m 20 "$url" 2>/dev/null | version_in || true
}

if [ "${1:-}" = "status" ]; then
  here="$(version_in < "$SCRIPT")"
  branch="$(git fetch -q origin "$RELEASE_BRANCH" 2>/dev/null && git show "FETCH_HEAD:$SCRIPT" 2>/dev/null | version_in || echo "(no $RELEASE_BRANCH branch)")"
  live="$(published_version)"
  printf '  here           %s\n  %-14s %s\n  greasy fork    %s\n' "$here" "$RELEASE_BRANCH" "$branch" "${live:-(unreachable)}"
  if [ -n "$live" ] && [ "$branch" != "$live" ]; then
    echo
    echo "The release branch and Greasy Fork disagree. Either a publish is still syncing, or"
    echo "the webhook did not fire - check the script's admin page: $GF_PAGE/admin"
  fi
  exit 0
fi

BUMP="${1:-}"
DRY=0
TAG=0
PUBLISH=0
for arg in "${@:2}"; do
  case "$arg" in
    --dry-run) DRY=1 ;;
    --tag)     TAG=1 ;;
    --publish) PUBLISH=1; TAG=1 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

[ -n "$BUMP" ] || { sed -n '11,20p' "${BASH_SOURCE[0]}" | sed 's|^# \{0,1\}||' >&2; exit 2; }
[ -f "$SCRIPT" ] || { echo "no $SCRIPT here" >&2; exit 1; }

if [ "$PUBLISH" -eq 1 ] && [ "$DRY" -eq 0 ]; then
  # Publishing a tree with uncommitted edits would release something that is not in git.
  if ! git diff --quiet || ! git diff --cached --quiet; then
    echo "Refusing to publish with uncommitted changes. Commit or stash them first." >&2
    exit 1
  fi
  if command -v node >/dev/null 2>&1; then
    node tests/run.mjs >/dev/null || { echo "Checks fail; not publishing. Run: node tests/run.mjs" >&2; exit 1; }
  fi
  # Only ever move release forward. If release holds a commit this branch does not,
  # overwriting it would silently un-publish that. Checked before bumping, so a refusal
  # leaves nothing behind to clean up.
  if git fetch -q origin "$RELEASE_BRANCH" 2>/dev/null; then
    if ! git merge-base --is-ancestor FETCH_HEAD HEAD; then
      echo "Refusing to publish: $RELEASE_BRANCH has commits that are not on this branch." >&2
      echo "Merge them here first. Nothing was changed." >&2
      exit 1
    fi
  fi
fi

meta="$(version_in < "$SCRIPT")"
code="$(grep -m1 'const VERSION' "$SCRIPT" | sed "s/.*'\(.*\)'.*/\1/")"

if [ "$meta" != "$code" ]; then
  echo "Refusing to bump: the two versions already disagree." >&2
  echo "  @version      $meta" >&2
  echo "  const VERSION $code" >&2
  echo "Fix them by hand first, so the bump starts from a known state." >&2
  exit 1
fi

IFS=. read -r MA MI PA <<< "$meta"
case "$BUMP" in
  major) NEW="$((MA + 1)).0.0" ;;
  minor) NEW="${MA}.$((MI + 1)).0" ;;
  patch) NEW="${MA}.${MI}.$((PA + 1))" ;;
  [0-9]*.[0-9]*.[0-9]*) NEW="$BUMP" ;;
  *) echo "not a bump or a version: $BUMP" >&2; exit 2 ;;
esac

echo "$meta -> $NEW"

if [ "$DRY" -eq 1 ]; then
  echo
  echo "would change:"
  echo "  $SCRIPT   @version and const VERSION"
  echo "  $CHANGELOG  move [Unreleased] entries under [$NEW] dated $(date +%F)"
  [ "$TAG" -eq 1 ] && echo "  git tag v$NEW"
  [ "$PUBLISH" -eq 1 ] && echo "  push, move $RELEASE_BRANCH to this commit, wait for Greasy Fork to show $NEW"
  echo
  echo "(dry run, nothing written)"
  exit 0
fi

# Anchored so a version-like string elsewhere in the file cannot be caught by accident.
sed -i "s|^// @version      .*|// @version      $NEW|" "$SCRIPT"
sed -i "s|^  const VERSION = '.*';|  const VERSION = '$NEW';|" "$SCRIPT"

after_meta="$(version_in < "$SCRIPT")"
after_code="$(grep -m1 'const VERSION' "$SCRIPT" | sed "s/.*'\(.*\)'.*/\1/")"
if [ "$after_meta" != "$NEW" ] || [ "$after_code" != "$NEW" ]; then
  echo "Bump failed: got @version=$after_meta const VERSION=$after_code" >&2
  echo "Nothing was committed. Check the file and retry." >&2
  exit 1
fi

if command -v node >/dev/null 2>&1; then
  node --check "$SCRIPT" >/dev/null || { echo "the script no longer parses; not committing" >&2; exit 1; }
fi

if [ -f "$CHANGELOG" ] && grep -q '^## \[Unreleased\]' "$CHANGELOG"; then
  python3 - "$CHANGELOG" "$NEW" <<'PY'
import datetime, re, sys
path, new = sys.argv[1], sys.argv[2]
text = open(path).read()
# Everything between the Unreleased heading and the next version heading is this release.
m = re.search(r'^## \[Unreleased\]\n(.*?)(?=^## \[)', text, re.S | re.M)
body = (m.group(1).strip() if m else '')
if not body:
    print("  changelog: [Unreleased] is empty, leaving it alone")
    raise SystemExit(0)
heading = f"## [{new}] - {datetime.date.today()}"
text = text.replace(m.group(0), f"## [Unreleased]\n\n{heading}\n\n{body}\n\n", 1)
open(path, 'w').write(text)
print(f"  changelog: moved {len(body.splitlines())} lines under {heading}")
PY
fi

git add "$SCRIPT" "$CHANGELOG" 2>/dev/null || git add "$SCRIPT"
git commit -q -m "Release $NEW"
echo "  committed: Release $NEW"

if [ "$TAG" -eq 1 ]; then
  git tag -a "v$NEW" -m "Release $NEW"
  echo "  tagged: v$NEW"
fi

if [ "$PUBLISH" -eq 0 ]; then
  echo
  echo "Not published. To publish this one: git push, then"
  echo "  git push origin HEAD:$RELEASE_BRANCH"
  exit 0
fi

echo
echo "Publishing $NEW"

branch="$(git rev-parse --abbrev-ref HEAD)"
git push -q origin "$branch"
git push -q origin "v$NEW"
git push -q origin "HEAD:refs/heads/$RELEASE_BRANCH"
echo "  pushed $branch, v$NEW, and $RELEASE_BRANCH"

echo "  waiting for Greasy Fork to report $NEW"
for i in $(seq 1 "$POLL_TRIES"); do
  live="$(published_version)"
  if [ "$live" = "$NEW" ]; then
    echo "  live on Greasy Fork: $NEW"
    echo "  $GF_PAGE"
    exit 0
  fi
  printf '    %s  greasy fork still shows %s\n' "$(date +%H:%M:%S)" "${live:-(unreachable)}"
  sleep "$POLL_SECONDS"
done

echo >&2
echo "Greasy Fork still does not show $NEW after $((POLL_TRIES * POLL_SECONDS))s." >&2
echo "Git has it; the sync did not happen. Check the sync log on the admin page," >&2
echo "or press Sync there by hand: $GF_PAGE/admin" >&2
exit 1
