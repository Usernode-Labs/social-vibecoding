#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
target_root="${AGENT_SKILL_SETUP_ROOT:-$repo_root}"
skills=()

for skill_path in "$repo_root"/agent-skills/*; do
  [[ -f "$skill_path/SKILL.md" ]] || continue
  skills+=("$(basename "$skill_path")")
done

if [[ "${#skills[@]}" -eq 0 ]]; then
  printf 'No canonical skills found under agent-skills/.\n' >&2
  exit 1
fi

for adapter in .agents .claude; do
  mkdir -p "$target_root/$adapter/skills"
  for skill in "${skills[@]}"; do
    if [[ "$target_root" == "$repo_root" ]]; then
      source="../../agent-skills/$skill"
    else
      source="$repo_root/agent-skills/$skill"
    fi
    ln -sfn "$source" "$target_root/$adapter/skills/$skill"
  done
done

printf 'Installed %d canonical skill adapter(s) for .agents and .claude.\n' "${#skills[@]}"
