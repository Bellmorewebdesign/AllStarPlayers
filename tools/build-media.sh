#!/usr/bin/env bash
#
# All Star Players / media build
# ------------------------------------------------------------------------
# Regenerates everything in assets/img and assets/video from the untouched
# originals in assets/img/originals and assets/video/originals.
#
# You only need this if you add or replace a source photo or the store video.
# The generated files are committed, so the site works without ever running it.
#
# Needs: ffmpeg, ImageMagick (convert), cwebp
#   sudo apt-get install ffmpeg imagemagick webp
#
# Run from the repository root:  bash tools/build-media.sh
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ORIG="$ROOT/assets/img/originals"
VSRC="$ROOT/assets/video/originals/store-tour-source.mov"
OUT="$ROOT/assets/img"
VOUT="$ROOT/assets/video"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$OUT" "$VOUT"

# The phone shoots HLG / BT.2020 HDR. Without this the web copies come out
# grey and washed out, so every frame and every encode goes through it.
TONEMAP="zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv"

say() { printf '  %s\n' "$*"; }

# ══════════════════════════════════════════════════ still frames ══════
# Grabbed once at full resolution, then cropped below like any other photo.
echo "Pulling still frames from the store video"
grab() {
  ffmpeg -y -v error -i "$VSRC" -ss "$1" -vf "$TONEMAP,format=yuv420p" \
         -frames:v 1 -q:v 1 "$TMP/$2.jpg"
  say "$2.jpg  (t=$1)"
}
grab 0.20  vid-storefront
grab 2.60  vid-aisle
grab 5.80  vid-rail
grab 6.80  vid-hats
grab 10.40 vid-shelves
grab 12.80 vid-turf

# ═════════════════════════════════════════════════════ pictures ═══════
# make <name> <source> <crop WxH+X+Y | full> <width,width,…> [quality]
# Writes name-WIDTH.webp and name-WIDTH.jpg for each width. A width larger
# than the crop is skipped, so nothing is ever upscaled. Quality defaults to
# 82; the category tiles pass a lower number because they always sit under a
# heavy dark gradient and nobody can tell.
make() {
  local name="$1" src="$2" crop="$3" widths="$4"
  local q="${5:-82}"
  local base="$TMP/base-$name.png" w

  if [ "$crop" = "full" ]; then
    convert "$src" -auto-orient "$base"
  else
    convert "$src" -auto-orient -crop "$crop" +repage "$base"
  fi
  local srcw; srcw=$(identify -format '%w' "$base")

  for w in ${widths//,/ }; do
    [ "$w" -gt "$srcw" ] && w="$srcw"
    convert "$base" -resize "${w}x" -unsharp 0x0.6+0.5+0.02 \
            -quality "$q" -sampling-factor 4:2:0 -strip -interlace Plane \
            "$OUT/$name-$w.jpg"
    cwebp -quiet -q $((q - 6)) -m 6 -sharp_yuv "$OUT/$name-$w.jpg" -o "$OUT/$name-$w.webp"
  done
  say "$name  (${srcw}px source)"
}

echo "Building pictures"

# ---- storefront + sign, used by the page backgrounds and the map panel ----
make sign            "$ORIG/IMG_0589.jpeg"  "1290x726+0+300"      "560,830"
make visit-storefront "$ORIG/IMG_0589.jpeg" "1290x1270+0+0"       "560,946"

# ---- the video poster: the sign, which is also how the film opens ----
make hero-poster     "$TMP/vid-storefront.jpg" "full"             "640,1000,1600"

# ---- inside the store ----
make interior        "$ORIG/IMG_0596.jpeg"  "full"                "620,1000"
make cards           "$ORIG/IMG_0592.jpeg"  "1290x869+0+190"      "560,980"

# ---- category tiles ----
make cat-tees        "$ORIG/IMG_0596.jpeg"  "1170x1080+60+40"     "420,780" 72
make cat-hoodies     "$ORIG/IMG_0596.jpeg"  "660x430+610+1100"    "420,660" 72
make cat-sneakers    "$ORIG/IMG_0596.jpeg"  "740x430+120+700"     "420,740" 72
make cat-hats        "$TMP/vid-hats.jpg"    "1500x844+300+120"    "420,840" 72
make cat-pants       "$ORIG/IMG_0596.jpeg"  "700x440+20+1150"     "430,700" 72
make cat-shorts      "$ORIG/IMG_0673.jpeg"  "950x690+40+680"      "430,860" 72
make cat-accessories "$ORIG/IMG_0670.jpeg"  "1136x1136+34+0"      "420,840" 72

# ---- shop cards, all cropped to the 4:5 the card grid expects ----
make floor-tees-wall   "$ORIG/IMG_0596.jpeg"    "800x1000+40+60"    "400,800"
make floor-tees-flat   "$ORIG/IMG_0669.jpeg"    "592x740+110+430"   "400,592"
make floor-tees-rail   "$TMP/vid-rail.jpg"      "620x700+330+400"   "400,620"
make floor-fleece-shelf "$ORIG/IMG_0596.jpeg"   "700x875+30+700"    "400,700"
make floor-fleece-rack  "$ORIG/IMG_0596.jpeg"   "560x700+700+1000"  "400,560"
make floor-pants-rack  "$ORIG/IMG_0673.jpeg"    "620x775+200+180"   "400,620"
make floor-pants-fold  "$ORIG/IMG_0596.jpeg"    "620x680+30+1010"   "400,620"
make floor-shorts-rack "$ORIG/IMG_0673.jpeg"    "700x875+400+400"   "400,700"
make floor-shorts-star "$ORIG/IMG_0673.jpeg"    "560x700+610+740"   "400,560"
make floor-sneakers    "$ORIG/IMG_0596.jpeg"    "560x700+120+430"   "400,560"
make floor-hats-wall   "$TMP/vid-hats.jpg"      "864x1080+520+0"    "400,864"
make floor-caps-flat   "$ORIG/IMG_0669.jpeg"    "800x1000+185+0"    "400,800"
make floor-acc-flat    "$ORIG/IMG_0670.jpeg"    "880x1100+230+30"   "400,880"
make floor-acc-detail  "$ORIG/IMG_0670.jpeg"    "560x700+20+40"     "400,560"

# ---- the wide band of shop photography on the home page ----
make gal-aisle       "$TMP/vid-aisle.jpg"   "1500x1000+220+50"    "560,1100"
make gal-rail        "$TMP/vid-rail.jpg"    "1500x1000+300+70"    "560,1100"
make gal-turf        "$TMP/vid-turf.jpg"    "1500x1000+300+40"    "560,1100"

# ---- social share card ----
convert "$TMP/vid-storefront.jpg" -resize 1200x630^ -gravity center \
        -extent 1200x630 -quality 84 -strip "$ROOT/assets/brand/og-image.jpg"
say "og-image.jpg"

# ═══════════════════════════════════════════════════════ video ════════
# Two H.264 files, chosen at runtime by js/main.js. Both fade up from black
# and back down to it so the loop turns over without a hard cut, and both
# keep their audio so the sound button on the hero has something to unmute.
echo "Encoding the hero video"
encode() {
  local w="$1" h="$2" crf="$3"
  local out="$VOUT/store-tour-$w.mp4"
  ffmpeg -y -v error -i "$VSRC" \
    -vf "$TONEMAP,fps=24,scale=$w:$h:flags=lanczos,fade=t=in:st=0:d=0.6,fade=t=out:st=15.35:d=0.9,format=yuv420p" \
    -c:v libx264 -preset slow -crf "$crf" -profile:v high -level 4.0 -g 48 \
    -af "afade=t=in:st=0:d=0.6,afade=t=out:st=15.35:d=0.9" \
    -c:a aac -b:a 96k -ac 2 -movflags +faststart "$out"
  say "$(basename "$out")  $(du -h "$out" | cut -f1)"
}
encode 1280 720 30
encode 854  480 31

echo "Done."
