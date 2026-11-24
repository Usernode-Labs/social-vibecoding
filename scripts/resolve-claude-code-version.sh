#!/bin/bash
set -euo pipefail

version="$(npm view @anthropic-ai/claude-code@latest version)"
if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$ ]]; then
  printf 'Invalid Claude Code version from npm: %s\n' "$version" >&2
  exit 1
fi
printf '%s\n' "$version"
