#!/usr/bin/env bash
set -euo pipefail
shopt -s nullglob

HOME_DIR="${HOME%/}"
if [[ "$HOME_DIR" == */~ ]]; then
  HOME_DIR="${HOME_DIR%/~}"
fi

DEFAULT_SOURCE="$HOME_DIR/.coolify-volumes/storage/shared/archive"
DEFAULT_OUTPUT_DIR="/tmp"

usage() {
  cat <<'EOF'
Usage: scripts/package-archive-snapshot.sh [SOURCE_ARCHIVE_ROOT] [OUTPUT_TARBALL_OR_DIR]

Packages the latest archive snapshot plus all block .binprot files from the
snapshot block through best_tip into a tarball that can be extracted and passed
directly as --archive-path.

Defaults:
  SOURCE_ARCHIVE_ROOT: ~/.coolify-volumes/storage/shared/archive
  OUTPUT_TARBALL_OR_DIR: /tmp

The source should normally be the archive root containing:
  chain_id
  <chain_id>/manifest.json
  <chain_id>/blocks/

For convenience, passing the <chain_id> directory itself is also accepted.
EOF
}

die() {
  echo "error: $*" >&2
  exit 1
}

log() {
  printf '[%s] %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*" >&2
}

expand_path() {
  local path="$1"
  if [[ "$path" == "~" ]]; then
    printf '%s\n' "$HOME_DIR"
  elif [[ "$path" == "~/"* ]]; then
    printf '%s/%s\n' "$HOME_DIR" "${path#~/}"
  elif [[ "$path" == "$HOME_DIR/~/"* ]]; then
    printf '%s/%s\n' "$HOME_DIR" "${path#"$HOME_DIR/~/"}"
  else
    printf '%s\n' "$path"
  fi
}

json_string_field() {
  local file="$1"
  local field="$2"
  sed -n "s/.*\"${field}\"[[:space:]]*:[[:space:]]*\"\\([^\"]*\\)\".*/\\1/p" "$file" | head -n 1
}

json_number_field() {
  local file="$1"
  local field="$2"
  sed -n "s/.*\"${field}\"[[:space:]]*:[[:space:]]*\\([0-9][0-9]*\\).*/\\1/p" "$file" | head -n 1
}

capture_best_tip_pair() {
  local marker_path="$1"
  local metadata_path="$2"
  local staged_marker="$3"
  local staged_metadata="$4"
  local marker
  local metadata_hash
  local tmp_metadata
  local attempt

  tmp_metadata="${staged_metadata}.tmp.$$"
  mkdir -p "$(dirname "$staged_marker")"
  for attempt in {1..40}; do
    if [[ -f "$marker_path" && -f "$metadata_path" ]]; then
      if cp -p "$metadata_path" "$tmp_metadata" 2>/dev/null; then
        metadata_hash="$(json_string_field "$tmp_metadata" "hash")"
        marker="$(tr -d '[:space:]' < "$marker_path" || true)"
        if [[ -n "$marker" && -n "$metadata_hash" && "$marker" == "$metadata_hash" ]]; then
          mv "$tmp_metadata" "$staged_metadata"
          printf '%s\n' "$marker" > "$staged_marker"
          printf '%s\n' "$marker"
          return 0
        fi
      fi
    fi
    rm -f "$tmp_metadata"
    sleep 0.25
  done

  rm -f "$tmp_metadata"
  die "best_tip marker and metadata did not settle into a matching pair: $marker_path and $metadata_path"
}

stage_file() {
  local src="$1"
  local rel="$2"
  local dest="$stage/$rel"

  [[ "$rel" != /* ]] || die "refusing to stage absolute path: $rel"
  [[ "$rel" != *..* ]] || die "refusing to stage path containing '..': $rel"
  [[ -f "$src" ]] || die "source file not found while staging: $src"

  mkdir -p "$(dirname "$dest")"
  rm -f "$dest"
  if ! ln "$src" "$dest" 2>/dev/null; then
    cp -p "$src" "$dest"
  fi
}

snapshot_slot_from_protocol_file() {
  local protocol_file="$1"
  local base
  base="$(basename "$protocol_file")"
  if [[ "$base" =~ ^mid_epoch_([0-9]+)_([0-9]+)_ ]]; then
    printf '%s\n' "${BASH_REMATCH[2]}"
  elif [[ "$base" =~ ^epoch_([0-9]+)_ ]]; then
    printf '%s\n' "boundary"
  else
    printf '%s\n' "unknown"
  fi
}

build_block_index() {
  local blocks_dir="$1"
  local output="$2"

  (
    cd "$blocks_dir"
    find . -type f -name 'block_*.binprot' ! -name '*.apply.binprot' -print
  ) | sed 's#^\./##' | awk -F/ '
    {
      rel = $0
      name = $NF
      if (name !~ /^block_[0-9]+_[^_]+[.]binprot$/) {
        next
      }
      parsed = name
      sub(/^block_/, "", parsed)
      sub(/[.]binprot$/, "", parsed)
      split(parsed, parts, "_")
      print parts[1] "\t" parts[2] "\t" rel
    }
  ' > "$output"
}

block_index_find_hash() {
  local index="$1"
  local hash="$2"

  awk -F '\t' -v hash="$hash" '$2 == hash { line = $0 } END { if (line != "") print line; else exit 1 }' "$index"
}

select_index_block_files() {
  local index="$1"
  local chain="$2"
  local lo="$3"
  local hi="$4"
  local stats="$5"

  awk -F '\t' \
    -v chain="$chain" \
    -v lo="$lo" \
    -v hi="$hi" \
    -v stats="$stats" '
      {
        height = $1
        rel = $3
        height_num = height + 0
        if (height_num < lo || height_num > hi || (rel in seen_paths)) {
          next
        }
        seen_paths[rel] = 1
        print chain "/blocks/" rel
        block_count++
        if (!(height in seen_heights)) {
          seen_heights[height] = 1
          height_count++
        }
      }
      END {
        print block_count + 0, height_count + 0 > stats
      }
    ' "$index"
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

source_arg="${1:-$DEFAULT_SOURCE}"
output_arg="${2:-$DEFAULT_OUTPUT_DIR}"

source_path="$(expand_path "$source_arg")"
output_path="$(expand_path "$output_arg")"

[[ -d "$source_path" ]] || die "source archive directory not found: $source_path"
log "Inspecting archive source: $source_path"

archive_root="$source_path"
chain_id=""
chain_dir=""

if [[ -f "$source_path/chain_id" ]]; then
  chain_id="$(tr -d '[:space:]' < "$source_path/chain_id")"
  [[ -n "$chain_id" ]] || die "empty chain_id file: $source_path/chain_id"
  chain_dir="$source_path/$chain_id"
elif [[ -f "$source_path/manifest.json" ]]; then
  chain_dir="$source_path"
  chain_id="$(basename "$source_path")"
  archive_root="$(dirname "$source_path")"
else
  while IFS= read -r manifest; do
    if [[ -z "$chain_dir" ]]; then
      chain_dir="$(dirname "$manifest")"
      chain_id="$(basename "$chain_dir")"
    else
      die "multiple chain manifests found under $source_path; pass the archive root with chain_id or the desired chain directory"
    fi
  done < <(find "$source_path" -mindepth 2 -maxdepth 2 -type f -name manifest.json)
  [[ -n "$chain_dir" ]] || die "no chain manifest found under $source_path"
fi

manifest_path="$chain_dir/manifest.json"
blocks_dir="$chain_dir/blocks"

[[ -f "$manifest_path" ]] || die "manifest not found: $manifest_path"
[[ -d "$blocks_dir" ]] || die "blocks directory not found: $blocks_dir"
log "Using chain directory: $chain_dir"
log "Reading latest snapshot manifest: $manifest_path"

stage="$(mktemp -d "${TMPDIR:-/tmp}/usernode-archive-package.XXXXXX")"
tar_tmp=""
cleanup() {
  rm -rf "$stage"
  if [[ -n "${tar_tmp:-}" ]]; then
    rm -f "$tar_tmp"
  fi
}
trap cleanup EXIT

mkdir -p "$stage/$chain_id/blocks"
printf '%s\n' "$chain_id" > "$stage/chain_id"
stage_file "$manifest_path" "$chain_id/manifest.json"
manifest_path="$stage/$chain_id/manifest.json"

snapshot_epoch="$(json_number_field "$manifest_path" "epoch")"
snapshot_hash="$(json_string_field "$manifest_path" "block_hash")"
utxo_file="$(json_string_field "$manifest_path" "utxo_file")"
utxo_hashes_file="$(json_string_field "$manifest_path" "utxo_hashes_file" || true)"
identity_file="$(json_string_field "$manifest_path" "identity_file")"
protocol_file="$(json_string_field "$manifest_path" "protocol_file")"

[[ -n "$snapshot_epoch" ]] || die "manifest is missing latest.epoch"
[[ -n "$snapshot_hash" ]] || die "manifest is missing latest.block_hash"
[[ -n "$utxo_file" ]] || die "manifest is missing latest.utxo_file"
[[ -n "$identity_file" ]] || die "manifest is missing latest.identity_file"
[[ -n "$protocol_file" ]] || die "manifest is missing latest.protocol_file"

for required in "$utxo_file" "$identity_file" "$protocol_file"; do
  [[ -f "$chain_dir/$required" ]] || die "manifest references missing file: $chain_dir/$required"
  stage_file "$chain_dir/$required" "$chain_id/$required"
done
if [[ -n "$utxo_hashes_file" && ! -f "$chain_dir/$utxo_hashes_file" ]]; then
  die "manifest references missing file: $chain_dir/$utxo_hashes_file"
fi
if [[ -n "$utxo_hashes_file" ]]; then
  stage_file "$chain_dir/$utxo_hashes_file" "$chain_id/$utxo_hashes_file"
fi

best_tip_path="$blocks_dir/best_tip"
[[ -f "$best_tip_path" ]] || die "best_tip marker not found: $best_tip_path"
best_tip_metadata_source="$blocks_dir/best_tip.json"
[[ -f "$best_tip_metadata_source" ]] || die "best_tip metadata not found: $best_tip_metadata_source; run archive-epoch-migrator with the updated binary to generate it"
best_tip_metadata_path="$stage/$chain_id/blocks/best_tip.json"
best_tip_hash="$(capture_best_tip_pair "$best_tip_path" "$best_tip_metadata_source" "$stage/$chain_id/blocks/best_tip" "$best_tip_metadata_path")"
log "Captured stable best_tip metadata pair: $best_tip_hash"

block_index="$stage/block-index.tsv"
log "Indexing block dump filenames under: $blocks_dir"
build_block_index "$blocks_dir" "$block_index"
block_name_count="$(wc -l < "$block_index" | tr -d '[:space:]')"
log "Indexed $block_name_count block files"

snapshot_index_line="$(block_index_find_hash "$block_index" "$snapshot_hash")" || die "snapshot block dump not found for hash $snapshot_hash"
best_tip_index_line="$(block_index_find_hash "$block_index" "$best_tip_hash")" || die "best_tip block dump not found for hash $best_tip_hash"
IFS=$'\t' read -r snapshot_height _snapshot_hash snapshot_block_path <<< "$snapshot_index_line"
IFS=$'\t' read -r best_tip_height _best_tip_hash best_tip_block_path <<< "$best_tip_index_line"

[[ -n "$snapshot_height" ]] || die "block index is missing snapshot height for hash $snapshot_hash"
[[ -n "$snapshot_block_path" ]] || die "block index is missing snapshot path for hash $snapshot_hash"
[[ -n "$best_tip_height" ]] || die "block index is missing best_tip height for hash $best_tip_hash"
[[ -n "$best_tip_block_path" ]] || die "block index is missing best_tip path for hash $best_tip_hash"

best_tip_epoch="$(json_number_field "$best_tip_metadata_path" "epoch")"
best_tip_epoch_slot="$(json_number_field "$best_tip_metadata_path" "epoch_slot")"
best_tip_global_slot="$(json_number_field "$best_tip_metadata_path" "global_slot")"
best_tip_metadata_relative_path="$(json_string_field "$best_tip_metadata_path" "relative_path")"
if [[ -n "$best_tip_metadata_relative_path" && "$best_tip_metadata_relative_path" != "$best_tip_block_path" ]]; then
  die "best_tip metadata path $best_tip_metadata_relative_path does not match indexed path $best_tip_block_path"
fi

if (( best_tip_height < snapshot_height )); then
  die "best_tip height $best_tip_height is lower than snapshot height $snapshot_height"
fi

snapshot_slot="$(snapshot_slot_from_protocol_file "$protocol_file")"
if [[ -n "$best_tip_epoch" && -n "$best_tip_epoch_slot" ]]; then
  default_filename="usernode-archive-epoch-${best_tip_epoch}-slot-${best_tip_epoch_slot}.tar.gz"
  log "Packaging snapshot epoch=$snapshot_epoch slot=$snapshot_slot height=$snapshot_height through best_tip epoch=$best_tip_epoch slot=$best_tip_epoch_slot height=$best_tip_height"
elif [[ -n "$best_tip_global_slot" ]]; then
  default_filename="usernode-archive-global-slot-${best_tip_global_slot}.tar.gz"
  log "Packaging snapshot epoch=$snapshot_epoch slot=$snapshot_slot height=$snapshot_height through best_tip global_slot=$best_tip_global_slot height=$best_tip_height"
else
  default_filename="usernode-archive-snapshot-epoch-${snapshot_epoch}-slot-${snapshot_slot}-tip-height-${best_tip_height}.tar.gz"
  log "Packaging snapshot epoch=$snapshot_epoch slot=$snapshot_slot height=$snapshot_height through best_tip height=$best_tip_height"
fi

if [[ -d "$output_path" || "${output_arg}" == */ ]]; then
  mkdir -p "$output_path"
  tarball="$output_path/$default_filename"
else
  mkdir -p "$(dirname "$output_path")"
  tarball="$output_path"
fi
case "$tarball" in
  /*) ;;
  *) tarball="$PWD/$tarball" ;;
esac

filelist="$stage/archive-files.txt"
block_list="$stage/block-files.txt"
block_stats="$stage/block-stats.txt"

log "Building tar file list"
{
  printf '%s\n' "chain_id"
  printf '%s\n' "$chain_id/manifest.json"
  printf '%s\n' "$chain_id/$utxo_file"
  printf '%s\n' "$chain_id/$identity_file"
  printf '%s\n' "$chain_id/$protocol_file"
  printf '%s\n' "$chain_id/blocks/best_tip"
  printf '%s\n' "$chain_id/blocks/best_tip.json"
} > "$filelist"
if [[ -n "$utxo_hashes_file" ]]; then
  printf '%s\n' "$chain_id/$utxo_hashes_file" >> "$filelist"
fi

log "Selecting block files in height range ${snapshot_height}..${best_tip_height}"
select_index_block_files "$block_index" "$chain_id" "$snapshot_height" "$best_tip_height" "$block_stats" > "$block_list"

read -r block_count height_count < "$block_stats"
cat "$block_list" >> "$filelist"

if (( block_count == 0 )); then
  die "no block .binprot files selected for height range ${snapshot_height}..${best_tip_height}"
fi

log "Selected $block_count block files across $height_count observed heights"
log "Staging selected block files"
sidecar_count=0
while IFS= read -r block_rel; do
  block_name="${block_rel#"$chain_id/blocks/"}"
  [[ "$block_name" != "$block_rel" ]] || die "unexpected block path in file list: $block_rel"
  stage_file "$blocks_dir/$block_name" "$block_rel"
  sidecar_name="${block_name%.binprot}.apply.binprot"
  sidecar_source="$blocks_dir/$sidecar_name"
  if [[ -f "$sidecar_source" ]]; then
    sidecar_rel="$chain_id/blocks/$sidecar_name"
    printf '%s\n' "$sidecar_rel" >> "$filelist"
    stage_file "$sidecar_source" "$sidecar_rel"
    sidecar_count=$((sidecar_count + 1))
  fi
done < "$block_list"
log "Staged $sidecar_count block apply sidecar files"

log "Creating compressed tarball: $tarball"
tar_tmp="${tarball}.tmp.$$"
rm -f "$tar_tmp"
if command -v pigz >/dev/null 2>&1 && command -v pv >/dev/null 2>&1; then
  log "Compressing with pigz -1; pv will show stream throughput"
  (cd "$stage" && tar -cf - -T "$filelist") | pv | pigz -1 > "$tar_tmp"
elif command -v pigz >/dev/null 2>&1; then
  log "Compressing with pigz -1"
  (cd "$stage" && tar -cf - -T "$filelist") | pigz -1 > "$tar_tmp"
elif command -v pv >/dev/null 2>&1; then
  log "Compressing with gzip -1; pv will show stream throughput"
  (cd "$stage" && tar -cf - -T "$filelist") | pv | gzip -1 > "$tar_tmp"
else
  log "Compressing with gzip -1"
  (cd "$stage" && tar -cf - -T "$filelist") | gzip -1 > "$tar_tmp"
fi
mv "$tar_tmp" "$tarball"
log "Finished writing tarball"

cat <<EOF
Archive package written:
  tarball: $tarball
  source: $archive_root
  chain_id: $chain_id
  snapshot_epoch: $snapshot_epoch
  snapshot_slot: $snapshot_slot
  snapshot_height: $snapshot_height
  snapshot_hash: $snapshot_hash
  snapshot_block_path: $snapshot_block_path
  best_tip_epoch: ${best_tip_epoch:-unknown}
  best_tip_slot: ${best_tip_epoch_slot:-unknown}
  best_tip_global_slot: ${best_tip_global_slot:-unknown}
  best_tip_height: $best_tip_height
  best_tip_hash: $best_tip_hash
  best_tip_block_path: $best_tip_block_path
  block_binprot_files: $block_count
EOF
