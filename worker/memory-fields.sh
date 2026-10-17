# The memory this worker's container has used, as fields for a turn's
# __USERNODE_RESULT__ line (src/services/worker.js parseLine). Sourced (not
# run) by run-cc.sh and run-codex-agent.sh. POSIX sh: the runners are /bin/sh.
#
# 17 Oct 2026: the Homeroom bot's builds on the platform's own repository were
# OOM-killed partway through at the worker's 2g limit, and nothing recorded
# how close the builds that survived had come to it. Read from the
# container's own cgroup (v2):
#   mem_peak_mib   the most it has used since it started (memory.peak)
#   mem_limit_mib  its limit (memory.max; absent when it has none)
#   mem_oom_kills  processes the kernel killed in it for memory (memory.events)
# A file it cannot read leaves its field out; it never fails a turn.

usernode_memory_fields() {
  _mf_dir=${USERNODE_CGROUP_DIR:-/sys/fs/cgroup}
  _mf_out=""
  _mf_v=$(cat "$_mf_dir/memory.peak" 2>/dev/null)
  case "$_mf_v" in ''|*[!0-9]*) ;; *) _mf_out="$_mf_out mem_peak_mib=$((_mf_v / 1048576))" ;; esac
  _mf_v=$(cat "$_mf_dir/memory.max" 2>/dev/null)
  case "$_mf_v" in ''|*[!0-9]*) ;; *) _mf_out="$_mf_out mem_limit_mib=$((_mf_v / 1048576))" ;; esac
  _mf_v=$(awk '$1 == "oom_kill" { print $2 }' "$_mf_dir/memory.events" 2>/dev/null)
  case "$_mf_v" in ''|*[!0-9]*) ;; *) _mf_out="$_mf_out mem_oom_kills=$_mf_v" ;; esac
  printf '%s' "$_mf_out"
}
