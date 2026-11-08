#!/usr/bin/env bash
# Regenerate the guide's measured tables and set plans from your own copies of the four example tracks.
# Usage: bash tools/make_guide_tables.sh [folder with the mp3 files]   (default: ~/Downloads)
set -euo pipefail
cd "$(dirname "$0")/.."
DIR="${1:-$HOME/Downloads}"
win() { if command -v cygpath >/dev/null; then cygpath -w "$1"; else echo "$1"; fi; }
find_one() { local f; f=$(ls "$DIR"/*"$1"*.mp3 | head -1); win "$f"; }
A=$(find_one "Alfaaz"); F=$(find_one "Faded"); S=$(find_one "Socha Hai"); X=$(find_one "time to Disco")
G=docs/guide/tex/generated
mkdir -p "$G"
node tools/plan.mjs --tex "$G/set1.tex" "$A" "$F"
node tools/plan.mjs --tex "$G/set2.tex" "$S" "$X"
node tools/plan.mjs --order auto --tex "$G/set_all.tex" "$A" "$F" "$S" "$X"
