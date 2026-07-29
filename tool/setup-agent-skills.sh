#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

for adapter in .agents .claude .codex; do
  mkdir -p "$root/$adapter/skills"
  ln -sfn "../../agent-skills/ui-development" "$root/$adapter/skills/ui-development"
done

printf 'Installed ui-development skill adapters for .agents, .claude, and .codex.\n'
