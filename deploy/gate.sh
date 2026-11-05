#!/usr/bin/env bash
# The eclume quality gate, from the workstation: sends the commit's `git archive` to the GPU host
# and runs deploy/gate-host.sh there, which proves the pillars of deploy/pillars.sh and publishes the
# `eclume/gate` status on the commit. Deploys and releases refuse a SHA without that status in `success`.
# Contract: docs/standards/code/monorepo.md; runbook: docs/project/host-setup.md.
#
# Usage: bash deploy/gate.sh [<ref>] [--pillars a,b | --all] [--background] [--supersedable] [--plan] [--context NAME]
#        bash deploy/gate.sh --status [<ref>]
#   <ref>           the commit proved (default: HEAD); the full gate needs the commit on GitHub.
#   --pillars       only these pillars (comma-separated), without publishing a status; no GitHub commit needed.
#   --all           publishes the status running every pillar; without it, the host runs only the pillars
#                   the diff since the last green SHA requires (deploy/gate.py) and the status names the skipped.
#   --background    lets the run go on the host and returns in seconds (the pre-push hook uses this mode,
#                   with the push still in flight); an unreachable host becomes a warning.
#   --supersedable  the host abandons the SHA if `main` has already moved past it (publishes `error`
#                   "superseded by <sha>"); the pre-push hook uses it, a manual request is never abandoned.
#   --status        shows the commit's `eclume/gate` status and the tail of the host log.
#   --plan          only shows what it would do (read-only).
#   --context       the host's Docker context (or $ECLUME_DOCKER_CONTEXT); required, no default.
# Variables: ECLUME_SSH (when the context is not ssh://); ECLUME_DISK_LIMIT and ECLUME_GPU_E2E_WAIT
#            (minutes gpu-e2e waits for a free GPU; the deprecated ECLUME_GPU_E2E_ESPERA still works)
#            go on to the host.
# A pre-rename SHA (one with deploy/pilares.sh) carries the old host script: prove it from its own checkout.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

CONTEXT="${ECLUME_DOCKER_CONTEXT:-}"
REPO=holetz/eclume
REF=HEAD
PILLARS=""
ALL=0
SUPERSEDABLE=0
BACKGROUND=0
STATUS=0
PLAN_ONLY=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --pillars)
      [[ $# -ge 2 && -n "$2" ]] || { echo "--pillars needs the list (python,web…)." >&2; exit 2; }
      PILLARS="$2"; shift 2 ;;
    --all) ALL=1; shift ;;
    --background) BACKGROUND=1; shift ;;
    --supersedable) SUPERSEDABLE=1; shift ;;
    --status) STATUS=1; shift ;;
    --plan|--dry-run) PLAN_ONLY=1; shift ;;
    --context)
      [[ $# -ge 2 && -n "$2" ]] || { echo "--context needs the name of a Docker context." >&2; exit 2; }
      CONTEXT="$2"; shift 2 ;;
    --help|-h) sed -n '2,23p' "$0"; exit 0 ;;
    -*) echo "Unknown flag: $1 (see --help)" >&2; exit 2 ;;
    *) REF="$1"; shift ;;
  esac
done

[[ -n "$CONTEXT" ]] || { echo "Missing the host's Docker context: --context NAME or ECLUME_DOCKER_CONTEXT." >&2; exit 2; }
SHA="$(git rev-parse --verify "$REF^{commit}")"
[[ -z "$PILLARS" || "$ALL" -eq 0 ]] || { echo "--all and --pillars do not go together." >&2; exit 2; }
if [[ -n "$PILLARS" ]]; then
  valid="$(bash deploy/pillars.sh --list | tr '\n' ' ')"
  IFS=, read -r -a requested <<< "$PILLARS"
  for p in "${requested[@]}"; do
    [[ " $valid" == *" $p "* ]] || { echo "Unknown pillar: $p (pillars: $valid)." >&2; exit 2; }
  done
fi

gate_status() {
  gh api "repos/$REPO/commits/$SHA/status" 2>/dev/null | python3 deploy/gate.py decide || true
}

endpoint="$(docker context inspect "$CONTEXT" --format '{{.Endpoints.docker.Host}}')"
SSH="${ECLUME_SSH:-${endpoint#ssh://}}"
[[ "$endpoint" == ssh://* || -n "${ECLUME_SSH:-}" ]] || {
  echo "Context $CONTEXT is not ssh:// ($endpoint); set ECLUME_SSH=user@host." >&2; exit 2; }
host() { ssh -o BatchMode=yes -o ConnectTimeout=5 -o ServerAliveInterval=60 "$SSH" "$@"; }

if [[ "$STATUS" -eq 1 ]]; then
  echo "Commit $SHA: $(gate_status)"
  # shellcheck disable=SC2016 # $HOME is the host's
  host 'f="$HOME/eclume-gate/logs/'"$SHA"'.log"; if test -f "$f"; then echo "Log $f:"; tail -n 15 "$f"; else echo "No host log for this commit."; fi'
  exit 0
fi

on_gh=1  # 1 = the commit is on GitHub
gh api "repos/$REPO/commits/$SHA" --silent 2>/dev/null || on_gh=0
mode="$([[ "$ALL" -eq 1 ]] && echo full || echo "by diff"), publishes $([[ "$BACKGROUND" -eq 1 ]] && echo "in the background" || echo "in the foreground")"
[[ -z "$PILLARS" ]] || mode="partial ($PILLARS), unpublished"
echo "Commit $SHA · gate $mode · host $SSH (context $CONTEXT)" >&2
if [[ "$PLAN_ONLY" -eq 1 ]]; then
  echo "On GitHub: $([[ "$on_gh" -eq 1 ]] && echo yes || echo no) · $(gate_status)" >&2
  exit 0
fi
if [[ -z "$PILLARS" && "$BACKGROUND" -eq 0 && "$on_gh" -eq 0 ]]; then
  echo "Commit $SHA is not on GitHub: push it first (the status is published on it)." >&2; exit 2
fi

# shellcheck disable=SC2016 # $HOME is the host's
DIR="$(host 'echo "$HOME"')/eclume-gate/src-$SHA-$(date +%s)"
echo "Sending the code of $SHA to $SSH:$DIR…" >&2
# Without the workstation's line-ending conversion (core.autocrlf): the host gets the commit's bytes.
git -c core.autocrlf=false archive --format=tar "$SHA" | host "mkdir -p '$DIR' && tar -x -C '$DIR'"

# The workstation's ECLUME_DISK_LIMIT goes on to the host, to raise the disk limit for a one-off gate.
gpu_wait="${ECLUME_GPU_E2E_WAIT:-${ECLUME_GPU_E2E_ESPERA:-}}"
envs=""
[[ -z "${ECLUME_DISK_LIMIT:-}" ]] || envs="ECLUME_DISK_LIMIT=${ECLUME_DISK_LIMIT//[^0-9]/} "
[[ -z "$gpu_wait" ]] || envs+="ECLUME_GPU_E2E_WAIT=${gpu_wait//[^0-9]/} "
args=(--sha "$SHA")
[[ -z "$PILLARS" ]] || args+=(--pillars "$PILLARS")
[[ "$ALL" -eq 0 ]] || args+=(--all)
[[ "$SUPERSEDABLE" -eq 0 ]] || args+=(--supersedable)
if [[ "$BACKGROUND" -eq 1 ]]; then
  host "${envs}setsid nohup bash '$DIR/deploy/gate-host.sh' ${args[*]} >/dev/null 2>&1 < /dev/null &"
  echo "Gate of $SHA let go on the host; follow it with: bash deploy/gate.sh --status $SHA" >&2
  exit 0
fi
host "${envs}bash '$DIR/deploy/gate-host.sh' ${args[*]}"
