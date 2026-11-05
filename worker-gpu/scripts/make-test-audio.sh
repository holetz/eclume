#!/usr/bin/env bash
# Generate the GPU worker's test audio, in the upload format (Opus mono 16 kHz, Ogg, 32 kbps;
# docs/standards/code/formato-audio-upload.md). Needs curl, ffmpeg and network access:
#
#   bash worker-gpu/scripts/make-test-audio.sh fixture <output.ogg>   # ~30 s, two real speakers (Common Voice, CC0)
#   bash worker-gpu/scripts/make-test-audio.sh bench <output.ogg>     # 1 h of real speech (LibriVox)
#
# `fixture`: pt-BR sentences read by two different real speakers, alternating, from six pinned clips
# of Common Voice pt 17.0 (CC0-1.0). Provenance: docs/project/fixtures-provenance.md.
# `bench`: short stories by Artur Azevedo read in Portuguese (LibriVox, public domain), cut to 1 h.
set -euo pipefail

mode="${1:?usage: make-test-audio.sh fixture|bench <output.ogg>}"
CV_REVISION=8262c16bf297c87a9cd88c51997c4758ed7a8ba2  # fsicoli/common_voice_17_0, a mirror of Common Voice 17.0 (CC0-1.0)
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
  # Six clips of Common Voice pt 17.0 (CC0-1.0), two real speakers alternating: a woman (A) and a
  # man (B). The dataset keeps the clips inside one 291 MB tar, so each clip is read with one Range
  # request at its data offset in the tar and checked against its sha256. Fields: id, speaker,
  # offset, size, sha256.
  local base="https://huggingface.co/datasets/fsicoli/common_voice_17_0/resolve/$CV_REVISION"
  local clips=(
    "19839027 A 39085568 46317 31a0767d529251ead6c32031c8f675039bada3875b897f316e4d96b411cc8e01"
    "19372052 B 12950016 36333 6ee2198f128b775a70c6d5bce70a0b3c7fb2fc2a4d2fcc33f1ec59239d31ef07"
    "19839054 A 39385600 31725 85064434426548dc0398f79c2fe14bda63b75e7876c619c118c766288affbd69"
    "19372064 B 13201920 39213 20de6d94225e09aa95c3258246160b4bfd67d2cefe764e1fcb1aa5606029a51e"
    "19839053 A 39347200 37677 0051b8c04a6f602435ddd78b06f10e21a93a54b28a36c22adf92737ed914ee27"
    "19372093 B 13451776 44013 c0a9de540038caacfc9e2af36b5e30a21cf54017f512a97da108c2af5326cc72"
  )
  ffmpeg -hide_banner -loglevel error -f lavfi -i anullsrc=r=16000:cl=mono -t 0.4 "$work/pause.wav"
  : > "$work/list.txt"
  local clip id offset size sha
  for clip in "${clips[@]}"; do
    read -r id _ offset size sha <<< "$clip"
    curl -fsSL -r "$offset-$((offset + size - 1))" -o "$work/$id.mp3" "$base/audio/pt/dev/pt_dev_0.tar"
    echo "$sha  $work/$id.mp3" | sha256sum --check --status \
      || { echo "clip $id does not match its pinned sha256" >&2; exit 1; }
    ffmpeg -hide_banner -loglevel error -y -i "$work/$id.mp3" -ac 1 -ar 16000 "$work/$id.wav"
    printf "file '%s'\nfile '%s'\n" "$work/$id.wav" "$work/pause.wav" >> "$work/list.txt"
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
