#!/usr/bin/env bash
# Gera os áudios de teste do worker GPU, no formato do upload (Opus mono 16 kHz, Ogg, 32 kbps;
# docs/standards/code/formato-audio-upload.md). Roda no host GPU (precisa de Docker e ffmpeg):
#
#   bash worker-gpu/scripts/make-test-audio.sh fixture <saída.ogg>   # ~30 s, duas vozes (Piper TTS)
#   bash worker-gpu/scripts/make-test-audio.sh bench <saída.ogg>     # 1 h de fala real (LibriVox)
#
# `fixture`: diálogo pt-BR sintetizado com duas vozes distintas do Piper (faber e cadu), alternadas.
# `bench`: contos de Artur Azevedo lidos em português (LibriVox, domínio público), cortados em 1 h.
set -euo pipefail

mode="${1:?uso: make-test-audio.sh fixture|bench <saída.ogg>}"
out="$(realpath -m "${2:?informe o arquivo de saída}")"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$(dirname "$out")"

encode() {  # encode <entrada> <saída> [ffmpeg-args extras]
  local input="$1" output="$2"
  shift 2
  ffmpeg -hide_banner -loglevel error -y -i "$input" "$@" \
    -ac 1 -ar 16000 -c:a libopus -b:a 32k -application voip "$output"
}

fixture() {
  cat > "$work/falas.tsv" <<'FALAS'
faber	Bom dia, pessoal. Obrigado por virem. Hoje vamos fechar o cronograma do programa de lideranças.
cadu	Bom dia. Eu trouxe a proposta revisada, com os três módulos e as datas de cada turma.
faber	Ótimo. O primeiro módulo começa em março, certo? Precisamos confirmar a sala com o financeiro.
cadu	Isso, começa na segunda semana de março. Eu falo com o financeiro ainda hoje à tarde.
faber	Perfeito. Então a próxima reunião fica para sexta-feira, às dez horas.
FALAS
  docker run --rm -v "$work:/work" -w /work python:3.12-slim bash -euo pipefail -c '
    pip install --quiet --root-user-action=ignore piper-tts >/dev/null
    python -m piper.download_voices --data-dir /work/voices pt_BR-faber-medium pt_BR-cadu-medium >/dev/null
    n=0
    while IFS=$(printf "\t") read -r voz texto; do
      n=$((n + 1))
      printf "%s" "$texto" | python -m piper --data-dir /work/voices -m "pt_BR-$voz-medium" -f "/work/fala-$(printf %02d $n).wav"
    done < falas.tsv
    chown -R '"$(id -u):$(id -g)"' /work
  '
  : > "$work/lista.txt"
  ffmpeg -hide_banner -loglevel error -f lavfi -i anullsrc=r=22050:cl=mono -t 0.6 "$work/pausa.wav"
  for wav in "$work"/fala-*.wav; do
    printf "file '%s'\nfile '%s'\n" "$wav" "$work/pausa.wav" >> "$work/lista.txt"
  done
  ffmpeg -hide_banner -loglevel error -f concat -safe 0 -i "$work/lista.txt" -c copy "$work/dialogo.wav"
  encode "$work/dialogo.wav" "$out"
}

bench() {
  local base="https://archive.org/download/contos1_0911_librivox"
  : > "$work/lista.txt"
  for n in 02 05 06 13 17; do
    curl -fsSL -o "$work/$n.mp3" "$base/contos_${n}_azevedo_64kb.mp3"
    printf "file '%s'\n" "$work/$n.mp3" >> "$work/lista.txt"
  done
  ffmpeg -hide_banner -loglevel error -f concat -safe 0 -i "$work/lista.txt" -c copy "$work/todos.mp3"
  encode "$work/todos.mp3" "$out" -t 3600
}

"$mode"
ffprobe -v error -show_entries format=duration:stream=codec_name,channels -of compact "$out"
