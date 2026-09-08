#!/usr/bin/env bash
#
# Bump the version in the one place a human should have to think about it: an argument.
#
# The version lives twice - `@version` in the metadata block, which is what a userscript
# manager and Greasy Fork read, and `const VERSION`, which is what the script reports in
# its boot line and its debug sheet. They must agree. When they drift, the manager and the
# running script disagree about what is installed, and the debug output starts lying about
# which build produced it. This is the only thing that should write either of them.
#
# Usage:
#   scripts/release.sh patch|minor|major|X.Y.Z [--dry-run] [--tag]
#
#   --dry-run   print what would change and touch nothing
#   --tag       also create an annotated git tag v<version>
#
# Moves everything under "## [Unreleased]" in CHANGELOG.md into a dated section for the new
# version, and commits. Publishing is a separate step; this only prepares the release.

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

SCRIPT="youtube-declutter.user.js"
CHANGELOG="CHANGELOG.md"

BUMP="${1:-}"
DRY=0
TAG=0
for arg in "${@:2}"; do
  case "$arg" in
    --dry-run) DRY=1 ;;
    --tag)     TAG=1 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

[ -n "$BUMP" ] || { sed -n '3,20p' "${BASH_SOURCE[0]}" | sed 's|^# \{0,1\}||' >&2; exit 2; }
[ -f "$SCRIPT" ] || { echo "no $SCRIPT here" >&2; exit 1; }

meta="$(grep -m1 '^// @version' "$SCRIPT" | awk '{print $3}')"
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
  echo
  echo "(dry run, nothing written)"
  exit 0
fi

# Anchored so a version-like string elsewhere in the file cannot be caught by accident.
sed -i "s|^// @version      .*|// @version      $NEW|" "$SCRIPT"
sed -i "s|^  const VERSION = '.*';|  const VERSION = '$NEW';|" "$SCRIPT"

after_meta="$(grep -m1 '^// @version' "$SCRIPT" | awk '{print $3}')"
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

echo
echo "Done. Publishing is separate: push, and Greasy Fork syncs from the repo."
