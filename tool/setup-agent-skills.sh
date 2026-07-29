#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
target_root="${AGENT_SKILL_SETUP_ROOT:-$repo_root}"

for adapter in .agents .claude .codex; do
  mkdir -p "$target_root/$adapter/skills"
  if [[ "$target_root" == "$repo_root" ]]; then
    source="../../agent-skills/ui-development"
  else
    source="$repo_root/agent-skills/ui-development"
  fi
  ln -sfn "$source" "$target_root/$adapter/skills/ui-development"
done

printf 'Installed ui-development skill adapters for .agents, .claude, and .codex.\n'
