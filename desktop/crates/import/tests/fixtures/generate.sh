#!/usr/bin/env bash
# Generates the import fixtures with ffmpeg: 2 s of a 440 Hz tone in each format, with the
# recording date the tests expect. Run it from inside this folder; the files go into git (they
# are small) so the tests do not depend on ffmpeg.
set -euo pipefail
cd "$(dirname "$0")"

common=(-hide_banner -loglevel error -y)
tone=(-f lavfi -i "sine=frequency=440:duration=2:sample_rate=44100" -map_metadata -1)

# MP4/M4A: the date goes in the mvhd creation_time.
ffmpeg "${common[@]}" "${tone[@]}" -c:a aac -b:a 32k -ac 1 \
  -metadata creation_time=2026-09-19T14:02:00Z tone.m4a
# MP3 with ID3v2.4: the date goes in TDRC.
ffmpeg "${common[@]}" "${tone[@]}" -c:a libmp3lame -b:a 32k -ac 1 -id3v2_version 4 \
  -metadata date=2026-09-18 tone.mp3
# WAV with no date: falls back to the modification date.
ffmpeg "${common[@]}" "${tone[@]}" -ar 8000 -ac 1 -c:a pcm_s16le tone.wav
# WebM with Opus (symphonia demuxes, libopus decodes).
ffmpeg "${common[@]}" "${tone[@]}" -ar 48000 -c:a libopus -b:a 24k -ac 1 tone.webm
# Ogg Vorbis with the date in the DATE comment.
ffmpeg "${common[@]}" "${tone[@]}" -c:a libvorbis -q:a 0 -ac 1 -metadata DATE=2026-09-17 tone.ogg
# AVI: symphonia does not read the container; it goes through the copy fallback.
ffmpeg "${common[@]}" "${tone[@]}" -c:a pcm_u8 -ar 8000 -ac 1 tone.avi
# MP4 with video only: there is no audio to import.
ffmpeg "${common[@]}" -f lavfi -i "color=c=black:s=16x16:d=1:r=5" -map_metadata -1 -c:v libx264 -pix_fmt yuv420p \
  -an no-audio.mp4
