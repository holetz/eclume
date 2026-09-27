#!/usr/bin/env bash
# Gera as fixtures de mídia dos testes de navegador de src/lib/media-convert/.
# Cada uma tem áudio estéreo 48 kHz (tons diferentes por canal + ruído, para o Opus VBR
# gastar bits como gastaria com fala) e, nos contêineres de vídeo, um vídeo de teste.
# Uso: bash scripts/media-fixtures.sh   (requer ffmpeg com libx264, libvpx, libvorbis,
# libopus e libmp3lame)
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=src/lib/media-convert/__fixtures__
mkdir -p "$OUT"

audio() { # duração em segundos
  echo "aevalsrc=0.3*sin(2*PI*440*t)+0.1*(random(0)*2-1)|0.3*sin(2*PI*660*t)+0.1*(random(1)*2-1):s=48000:d=$1"
}
video() {
  echo "testsrc2=size=320x240:rate=25:duration=$1"
}
ff() { ffmpeg -hide_banner -loglevel error -y "$@"; }
# O início da gravação que o import lê antes de converter (recorded-at.ts): creation_time vira o
# mvhd do MP4/MOV/M4A e o DateUTC do MKV; no MP3, a data só com o dia vira a tag ID3 TDRC.
CREATED=(-metadata creation_time=2026-09-19T14:02:00Z)

ff -f lavfi -i "$(video 10)" -f lavfi -i "$(audio 10)" -c:v libx264 -pix_fmt yuv420p -c:a aac -b:a 128k "${CREATED[@]}" "$OUT/video.mp4"
ff -f lavfi -i "$(video 10)" -f lavfi -i "$(audio 10)" -c:v libx264 -pix_fmt yuv420p -c:a aac -b:a 128k "${CREATED[@]}" "$OUT/video.mov"
ff -f lavfi -i "$(audio 10)" -c:a aac -b:a 128k "${CREATED[@]}" "$OUT/audio.m4a"
ff -f lavfi -i "$(video 10)" -f lavfi -i "$(audio 10)" -c:v libvpx -b:v 300k -c:a libopus -b:a 96k "$OUT/video.webm"
ff -f lavfi -i "$(video 10)" -f lavfi -i "$(audio 10)" -c:v libx264 -pix_fmt yuv420p -c:a libvorbis -q:a 4 "${CREATED[@]}" "$OUT/video.mkv"
ff -f lavfi -i "$(audio 10)" -c:a libmp3lame -b:a 128k -metadata date=2026-09-19 "$OUT/audio.mp3"
ff -f lavfi -i "$(audio 10)" -c:a pcm_s16le "$OUT/audio.wav"
ff -f lavfi -i "$(audio 10)" -c:a libvorbis -q:a 4 "$OUT/audio.ogg"
# AVI: contêiner que o Mediabunny não lê — exercita o fallback ffmpeg.wasm.
ff -f lavfi -i "$(video 10)" -f lavfi -i "$(audio 10)" -c:v mpeg4 -c:a libmp3lame -b:a 128k "$OUT/video.avi"
# Sem faixa de áudio.
ff -f lavfi -i "$(video 10)" -c:v libx264 -pix_fmt yuv420p "$OUT/sem-audio.mp4"
# Longas o bastante para o cancelamento chegar no meio da conversão.
ff -f lavfi -i "$(audio 120)" -c:a libopus -b:a 96k "$OUT/longo.webm"
ff -f lavfi -i "$(video 120)" -f lavfi -i "$(audio 120)" -c:v mpeg4 -c:a libmp3lame -b:a 128k "$OUT/longo.avi"

ls -la "$OUT"
