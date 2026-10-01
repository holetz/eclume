#!/usr/bin/env bash
# Gate de qualidade do eclume, a partir da estação: envia o `git archive` do commit para o host GPU
# e roda lá deploy/gate-host.sh, que prova os pilares de deploy/pilares.sh e publica o status
# `eclume/gate` no commit. Deploy e releases recusam um SHA sem esse status em `success`.
# Contrato: docs/standards/code/monorepo.md; runbook: docs/project/host-setup.md.
#
# Uso: bash deploy/gate.sh [<ref>] [--pilares a,b] [--fundo] [--plan] [--context NOME]
#      bash deploy/gate.sh --estado [<ref>]
#   <ref>       o commit provado (padrão: HEAD); o gate completo exige o commit no GitHub.
#   --pilares   só esses pilares (vírgulas), sem publicar status; não exige o commit no GitHub.
#   --fundo     solta a execução no host e volta em segundos (o hook de pre-push usa este modo,
#               com o push ainda em curso); host fora do alcance vira aviso.
#   --estado    mostra o status `eclume/gate` do commit e o fim do log no host.
#   --plan      só mostra o que faria (somente leitura).
#   --context   contexto Docker do host (padrão: $ECLUME_DOCKER_CONTEXT ou gpu-host).
# Variáveis: ECLUME_SSH (quando o contexto não é ssh://).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

CONTEXT="${ECLUME_DOCKER_CONTEXT:-gpu-host}"
REPO=holetz/eclume
REF=HEAD
PILARES=""
FUNDO=0
ESTADO=0
PLAN_ONLY=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --pilares)
      [[ $# -ge 2 && -n "$2" ]] || { echo "--pilares exige a lista (python,web…)." >&2; exit 2; }
      PILARES="$2"; shift 2 ;;
    --fundo) FUNDO=1; shift ;;
    --estado) ESTADO=1; shift ;;
    --plan|--dry-run) PLAN_ONLY=1; shift ;;
    --context)
      [[ $# -ge 2 && -n "$2" ]] || { echo "--context exige o nome de um contexto Docker." >&2; exit 2; }
      CONTEXT="$2"; shift 2 ;;
    --help|-h) sed -n '2,17p' "$0"; exit 0 ;;
    -*) echo "Flag desconhecida: $1" >&2; exit 2 ;;
    *) REF="$1"; shift ;;
  esac
done

SHA="$(git rev-parse --verify "$REF^{commit}")"
if [[ -n "$PILARES" ]]; then
  validos="$(bash deploy/pilares.sh --lista | tr '\n' ' ')"
  IFS=, read -r -a pedidos <<< "$PILARES"
  for p in "${pedidos[@]}"; do
    [[ " $validos" == *" $p "* ]] || { echo "Pilar desconhecido: $p (pilares: $validos)." >&2; exit 2; }
  done
fi

estado_gate() {
  gh api "repos/$REPO/commits/$SHA/status" 2>/dev/null | python3 deploy/gate.py decidir || true
}

endpoint="$(docker context inspect "$CONTEXT" --format '{{.Endpoints.docker.Host}}')"
SSH="${ECLUME_SSH:-${endpoint#ssh://}}"
[[ "$endpoint" == ssh://* || -n "${ECLUME_SSH:-}" ]] || {
  echo "O contexto $CONTEXT não é ssh:// ($endpoint); defina ECLUME_SSH=usuario@host." >&2; exit 2; }
host() { ssh -o BatchMode=yes -o ConnectTimeout=5 -o ServerAliveInterval=60 "$SSH" "$@"; }

if [[ "$ESTADO" -eq 1 ]]; then
  echo "Commit $SHA: $(estado_gate)"
  # shellcheck disable=SC2016 # o $HOME é o do host
  host 'f="$HOME/eclume-gate/logs/'"$SHA"'.log"; if test -f "$f"; then echo "Log $f:"; tail -n 15 "$f"; else echo "Sem log no host para este commit."; fi'
  exit 0
fi

commit_no_gh=1  # 1 = o commit está no GitHub
gh api "repos/$REPO/commits/$SHA" --silent 2>/dev/null || commit_no_gh=0
modo="completo, publica $([[ "$FUNDO" -eq 1 ]] && echo "em segundo plano" || echo "em primeiro plano")"
[[ -z "$PILARES" ]] || modo="parcial ($PILARES), sem publicar"
echo "Commit $SHA · gate $modo · host $SSH (contexto $CONTEXT)" >&2
if [[ "$PLAN_ONLY" -eq 1 ]]; then
  echo "No GitHub: $([[ "$commit_no_gh" -eq 1 ]] && echo sim || echo não) · $(estado_gate)" >&2
  exit 0
fi
if [[ -z "$PILARES" && "$FUNDO" -eq 0 && "$commit_no_gh" -eq 0 ]]; then
  echo "O commit $SHA não está no GitHub: faça o push antes (o status é publicado nele)." >&2; exit 2
fi

# shellcheck disable=SC2016 # o $HOME é o do host
DIR="$(host 'echo "$HOME"')/eclume-gate/src-$SHA-$(date +%s)"
echo "Enviando o código de $SHA para $SSH:$DIR…" >&2
# Sem a conversão de fim de linha da estação (core.autocrlf): o host recebe os bytes do commit.
git -c core.autocrlf=false archive --format=tar "$SHA" | host "mkdir -p '$DIR' && tar -x -C '$DIR'"

# ECLUME_DISK_LIMIT da estação segue para o host, para subir o limite de disco num gate pontual.
envs=""
[[ -z "${ECLUME_DISK_LIMIT:-}" ]] || envs="ECLUME_DISK_LIMIT=${ECLUME_DISK_LIMIT//[^0-9]/} "
args=(--sha "$SHA")
[[ -z "$PILARES" ]] || args+=(--pilares "$PILARES")
if [[ "$FUNDO" -eq 1 ]]; then
  host "${envs}setsid nohup bash '$DIR/deploy/gate-host.sh' ${args[*]} >/dev/null 2>&1 < /dev/null &"
  echo "Gate de $SHA solto no host; acompanhe com: bash deploy/gate.sh --estado $SHA" >&2
  exit 0
fi
host "${envs}bash '$DIR/deploy/gate-host.sh' ${args[*]}"
