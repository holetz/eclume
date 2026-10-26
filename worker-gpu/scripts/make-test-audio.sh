#!/usr/bin/env bash
# Generate the GPU worker's test audio, in the upload format (Opus mono 16 kHz, Ogg, 32 kbps;
# docs/standards/code/formato-audio-upload.md). Runs on the GPU host (needs Docker and ffmpeg):
#
#   bash worker-gpu/scripts/make-test-audio.sh fixture <output.ogg>   # ~30 s, two voices (Piper TTS)
#   bash worker-gpu/scripts/make-test-audio.sh bench <output.ogg>     # 1 h of real speech (LibriVox)
#
# `fixture`: pt-BR dialogue synthesized with two distinct Piper voices (faber and cadu), alternating.
# `bench`: short stories by Artur Azevedo read in Portuguese (LibriVox, public domain), cut to 1 h.
set -euo pipefail

mode="${1:?usage: make-test-audio.sh fixture|bench <output.ogg>}"
out="$(realpath -m "${2:?give the output file}")"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$(dirname "$out")"

encode() {  # encode <input> <output> [extra ffmpeg args]
  local input="$1" output="$2"
  shift 2
  ffmpeg -hide_banner -loglevel error -y -i "$input" "$@" \
    -ac 1 -ar 16000 -c:a libopus -b:a 32k -application voip "$output"
}

fixture() {
  cat > "$work/lines.tsv" <<'LINES'
faber	Bom dia, pessoal. Obrigado por virem. Hoje vamos fechar o cronograma do programa de lideranças.
cadu	Bom dia. Eu trouxe a proposta revisada, com os três módulos e as datas de cada turma.
faber	Ótimo. O primeiro módulo começa em março, certo? Precisamos confirmar a sala com o financeiro.
cadu	Isso, começa na segunda semana de março. Eu falo com o financeiro ainda hoje à tarde.
faber	Perfeito. Então a próxima reunião fica para sexta-feira, às dez horas.
LINES
  docker run --rm -v "$work:/work" -w /work python:3.12-slim bash -euo pipefail -c '
    pip install --quiet --root-user-action=ignore piper-tts >/dev/null
    python -m piper.download_voices --data-dir /work/voices pt_BR-faber-medium pt_BR-cadu-medium >/dev/null
    n=0
    while IFS=$(printf "\t") read -r voice text; do
      n=$((n + 1))
      printf "%s" "$text" | python -m piper --data-dir /work/voices -m "pt_BR-$voice-medium" -f "/work/line-$(printf %02d $n).wav"
    done < lines.tsv
    chown -R '"$(id -u):$(id -g)"' /work
  '
  : > "$work/list.txt"
  ffmpeg -hide_banner -loglevel error -f lavfi -i anullsrc=r=22050:cl=mono -t 0.6 "$work/pause.wav"
  for wav in "$work"/line-*.wav; do
    printf "file '%s'\nfile '%s'\n" "$wav" "$work/pause.wav" >> "$work/list.txt"
  done
  ffmpeg -hide_banner -loglevel error -f concat -safe 0 -i "$work/list.txt" -c copy "$work/dialogue.wav"
  encode "$work/dialogue.wav" "$out"
}

bench() {
  local base="https://archive.org/download/contos1_0911_librivox"
  : > "$work/list.txt"
  for n in 02 05 06 13 17; do
    curl -fsSL -o "$work/$n.mp3" "$base/contos_${n}_azevedo_64kb.mp3"
    printf "file '%s'\n" "$work/$n.mp3" >> "$work/list.txt"
  done
  ffmpeg -hide_banner -loglevel error -f concat -safe 0 -i "$work/list.txt" -c copy "$work/all.mp3"
  encode "$work/all.mp3" "$out" -t 3600
}

"$mode"
ffprobe -v error -show_entries format=duration:stream=codec_name,channels -of compact "$out"
