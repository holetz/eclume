#!/usr/bin/env bash
# Gera as fixtures da importação com o ffmpeg: 2 s de tom de 440 Hz em cada formato, com a data de
# gravação que os testes esperam. Rode de dentro desta pasta; os arquivos vão para o git (são
# pequenos) para os testes não dependerem do ffmpeg.
set -euo pipefail
cd "$(dirname "$0")"

comum=(-hide_banner -loglevel error -y)
tom=(-f lavfi -i "sine=frequency=440:duration=2:sample_rate=44100" -map_metadata -1)

# MP4/M4A: a data vai no creation_time do mvhd.
ffmpeg "${comum[@]}" "${tom[@]}" -c:a aac -b:a 32k -ac 1 \
  -metadata creation_time=2026-09-19T14:02:00Z tom.m4a
# MP3 com ID3v2.4: a data vai no TDRC.
ffmpeg "${comum[@]}" "${tom[@]}" -c:a libmp3lame -b:a 32k -ac 1 -id3v2_version 4 \
  -metadata date=2026-09-18 tom.mp3
# WAV sem data: cai na data de modificação.
ffmpeg "${comum[@]}" "${tom[@]}" -ar 8000 -ac 1 -c:a pcm_s16le tom.wav
# WebM com Opus (o symphonia demultiplexa, a libopus decodifica).
ffmpeg "${comum[@]}" "${tom[@]}" -ar 48000 -c:a libopus -b:a 24k -ac 1 tom.webm
# Ogg Vorbis com a data no comentário DATE.
ffmpeg "${comum[@]}" "${tom[@]}" -c:a libvorbis -q:a 0 -ac 1 -metadata DATE=2026-09-17 tom.ogg
# AVI: o symphonia não lê o contêiner; vai pelo fallback de cópia.
ffmpeg "${comum[@]}" "${tom[@]}" -c:a pcm_u8 -ar 8000 -ac 1 tom.avi
# MP4 só com vídeo: não há áudio para importar.
ffmpeg "${comum[@]}" -f lavfi -i "color=c=black:s=16x16:d=1:r=5" -map_metadata -1 -c:v libx264 -pix_fmt yuv420p \
  -an sem-audio.mp4
