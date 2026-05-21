#!/bin/bash
set -euo pipefail

# List GitHub issues for this repo.
#
# Usage:
#   ./scripts/list-issues.sh                  # open issues, table view
#   ./scripts/list-issues.sh --state closed
#   ./scripts/list-issues.sh --state all
#   ./scripts/list-issues.sh --label bug
#   ./scripts/list-issues.sh --json           # raw JSON (number,title,state,labels,url,updatedAt)
#   ./scripts/list-issues.sh 42               # show one issue's full body
#
# Auth resolution order:
#   1. `gh` CLI if `gh auth status` succeeds
#   2. $GH_TOKEN / $GITHUB_TOKEN / $GITHUB_BOT_TOKEN (auto-loaded from ./.env)
#      via curl against api.github.com
#
# Override the repo with REPO=owner/name (defaults to the `origin` remote).

STATE="open"
LABEL=""
JSON=0
SHOW_ONE=""

while [ $# -gt 0 ]; do
  case "$1" in
    --state) STATE="$2"; shift 2 ;;
    --label) LABEL="$2"; shift 2 ;;
    --json) JSON=1; shift ;;
    -h|--help) sed -n '3,18p' "$0"; exit 0 ;;
    *)
      if [[ "$1" =~ ^[0-9]+$ ]]; then SHOW_ONE="$1"; shift
      else echo "Unknown arg: $1" >&2; exit 2
      fi
      ;;
  esac
done

script_dir=$(cd "$(dirname "$0")" && pwd)
repo_root=$(cd "$script_dir/.." && pwd)

# Pull GITHUB_BOT_TOKEN (and friends) out of the repo's .env if present,
# without leaking everything else into the environment.
if [ -f "$repo_root/.env" ] && [ -z "${GH_TOKEN:-}${GITHUB_TOKEN:-}${GITHUB_BOT_TOKEN:-}" ]; then
  while IFS='=' read -r key val; do
    case "$key" in
      GH_TOKEN|GITHUB_TOKEN|GITHUB_BOT_TOKEN)
        val=${val%\"}; val=${val#\"}
        val=${val%\'}; val=${val#\'}
        export "$key=$val"
        ;;
    esac
  done < <(grep -E '^(GH_TOKEN|GITHUB_TOKEN|GITHUB_BOT_TOKEN)=' "$repo_root/.env" || true)
fi

# Resolve repo from $REPO, else the origin remote.
REPO="${REPO:-}"
if [ -z "$REPO" ]; then
  origin_url=$(git -C "$script_dir" config --get remote.origin.url 2>/dev/null || true)
  # Strip prefix (git@github.com: or https://github.com/) and any trailing .git
  REPO=${origin_url#*github.com[:/]}
  REPO=${REPO%.git}
fi

if [ -z "$REPO" ] || [[ "$REPO" != */* ]]; then
  echo "Could not determine repo. Set REPO=owner/name." >&2
  exit 1
fi

use_gh=0
if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  use_gh=1
fi

if [ -n "$SHOW_ONE" ]; then
  if [ "$use_gh" = 1 ]; then
    gh issue view "$SHOW_ONE" --repo "$REPO"
  else
    token="${GH_TOKEN:-${GITHUB_TOKEN:-${GITHUB_BOT_TOKEN:-}}}"
    [ -z "$token" ] && { echo "Need gh login or GH_TOKEN/GITHUB_TOKEN/GITHUB_BOT_TOKEN." >&2; exit 1; }
    curl -fsSL -H "Authorization: Bearer $token" -H "Accept: application/vnd.github+json" \
      "https://api.github.com/repos/${REPO}/issues/${SHOW_ONE}" |
      python3 -c '
import json, sys, textwrap
i = json.load(sys.stdin)
print(f"#{i[\"number\"]} {i[\"title\"]}  [{i[\"state\"]}]  ({i[\"html_url\"]})")
labels = ", ".join(l["name"] for l in i.get("labels", []))
if labels: print(f"labels: {labels}")
print()
print(i.get("body") or "(no body)")
'
  fi
  exit 0
fi

if [ "$use_gh" = 1 ]; then
  args=(--repo "$REPO" --state "$STATE" --limit 200)
  [ -n "$LABEL" ] && args+=(--label "$LABEL")
  if [ "$JSON" = 1 ]; then
    gh issue list "${args[@]}" --json number,title,state,labels,url,updatedAt
  else
    gh issue list "${args[@]}"
  fi
  exit 0
fi

token="${GH_TOKEN:-${GITHUB_TOKEN:-${GITHUB_BOT_TOKEN:-}}}"
if [ -z "$token" ]; then
  echo "gh is not authed and no GH_TOKEN/GITHUB_TOKEN/GITHUB_BOT_TOKEN found." >&2
  echo "Run: gh auth login -h github.com   (or export GH_TOKEN=...)" >&2
  exit 1
fi

url="https://api.github.com/repos/${REPO}/issues?state=${STATE}&per_page=100"
[ -n "$LABEL" ] && url="${url}&labels=${LABEL}"

# Paginate via Link header until exhausted.
tmp=$(mktemp); trap 'rm -f "$tmp"' EXIT
page_url="$url"
echo "[]" > "$tmp"
while [ -n "$page_url" ]; do
  headers=$(mktemp)
  body=$(curl -fsSL -D "$headers" \
    -H "Authorization: Bearer $token" \
    -H "Accept: application/vnd.github+json" \
    "$page_url")
  # Merge this page into the accumulator.
  python3 -c "
import json, sys
acc = json.load(open('$tmp'))
acc.extend(json.loads(sys.argv[1]))
json.dump(acc, open('$tmp','w'))
" "$body"
  # Next page from Link: <...>; rel=\"next\"
  page_url=$(awk -F'[<>]' '/^[Ll]ink:/ { for (i=1;i<=NF;i++) if ($i ~ /rel="next"/) print prev; prev=$0 }' "$headers" | head -n1)
  page_url=$(echo "$page_url" | sed -nE 's/.*<([^>]+)>; rel="next".*/\1/p')
  rm -f "$headers"
done

if [ "$JSON" = 1 ]; then
  cat "$tmp"
else
  python3 -c "
import json
for i in json.load(open('$tmp')):
    if 'pull_request' in i:  # /issues returns PRs too
        continue
    labels = ','.join(l['name'] for l in i.get('labels', []))
    print(f\"#{i['number']:<5} {i['state']:<6} {(labels or '-'):<20} {i['title']}\")
"
fi
