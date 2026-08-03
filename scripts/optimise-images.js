#!/usr/bin/env node
/**
 * Speed With Style — image optimiser.
 *
 * Turns the client's full-size edited JPEGs (5–7k px, ~85MB total) into the
 * web-sized WebP files the site actually serves. Run it again any time the
 * source photos change; it is idempotent and always writes from the original,
 * never from a previous output.
 *
 * Usage:  node scripts/optimise-images.js [--src <folder>]
 *
 * Crops are declared per image rather than left to sharp's attention-cropping,
 * which consistently picks the wrong part of a pool photo (it chases the high
 * contrast of lane ropes and windows instead of the people).
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'assets');

const DEFAULT_SRC =
  '/Users/alexanderoliver/Library/CloudStorage/Dropbox/CLIENTS/Speed with Style/Media/WEBSITE_ASSETS/CHOSEN_WEBSITE';

const srcFlag = process.argv.indexOf('--src');
const SRC = srcFlag !== -1 ? process.argv[srcFlag + 1] : DEFAULT_SRC;

const QUALITY = 78;

/**
 * position: where to anchor the crop when the target aspect differs from the
 *   source. 'centre' is the default; only stated when it matters.
 * extract:  {left, top, width, height} in SOURCE pixels, applied before the
 *   resize. Use when 'position' can't express the framing — the subject sits
 *   off-centre and cover-cropping either edge loses it.
 * widths:   extra narrower copies for a srcset, written as <name>-<width>.webp.
 * full:     also emit <name>-full.webp at this width with NO crop, so a
 *   lightbox can show the photographer's whole frame rather than our tile crop.
 */
const IMAGES = [
  // ---- Home ----
  {
    src: 'INSTRUCTORS_IN_WATER.JPG',
    out: 'hero.webp',
    width: 2000,
    height: 933,
    widths: [1200, 800],
  },
  {
    src: 'INSTRUCTORS_COACHING_2.JPG',
    out: 'learn-to-swim.webp',
    width: 1000,
    height: 667,
  },
  { src: 'MORNING_CLASS_2.JPG', out: 'pre-squad.webp', width: 1000,
    height: 667 },
  { src: 'MORNING_CLASS.JPG', out: 'squad.webp', width: 1000,
    height: 667 },
  {
    src: 'CORPUS_BANNER.JPG',
    out: 'corpus.webp',
    // Native 2:3, uncropped. The pennant tapers off the bottom of the original
    // frame — that is how it was shot, so showing the whole frame reads as the
    // photographer's crop rather than ours cutting it short.
    width: 1000,
    height: 1500,
  },
  {
    src: 'ROSS_NOTES_IN_SESSION.JPG',
    // Native 2:3 — deliberately uncropped, the layout is built around the whole
    // frame rather than the frame being cut to fit the layout.
    out: 'technique-whiteboard.webp',
    width: 1000,
    height: 1500,
  },

  // ---- "Why choose us" bento backgrounds ----
  // These sit under a heavy gradient and animated water overlay, so they are
  // atmosphere, not detail — hence the loose crops and modest widths.
  {
    src: 'INSTRUCTORS_COACHING.JPG',
    out: 'why-class-size.webp',
    // Cut to the tile's own 2.3:1 rather than a generic landscape — at 16:9 the
    // CSS then crops top and bottom again and takes the swimmer's raised arm
    // with it, which is the only thing making this a photo of a person.
    width: 1200,
    height: 520,
    position: 'top',
  },
  // Near-square, matching the tile: this one is shown as a photo now rather than
  // hidden under the old rising-water animation, so the crop has to hold up.
  { src: 'HEATED_POOL.JPG', out: 'why-heated.webp', width: 900, height: 860 },
  { src: 'JAY_OVERSEEING.JPG', out: 'instructors-poster.webp', width: 1000,
    height: 667 },

  // ---- What to expect ----
  { src: 'FACILITY/OUTSIDE.JPG', out: 'arrival-outside.webp', width: 1600, height: 900 },
  {
    src: 'FACILITY/PARENT_SEATING.JPG',
    out: 'parent-seating.webp',
    full: 1600,
    width: 1000,
    height: 667,
  },
  { src: 'FACILITY/OPEN_SHOWER.JPG', out: 'showers.webp',
    full: 1600, width: 800, height: 600 },

  // ---- Facility gallery (uniform 4:3 tiles, each with an uncropped -full) ----
  // Ordered as a walk-through: outside, in the door, then each pool. The
  // exteriors matter as much as the pools — a parent who has never been to
  // Corpus needs to recognise the building before they recognise the water.
  {
    src: 'FACILITY/OUTSIDE.JPG',
    out: 'facility-outside.webp',
    full: 1600,
    width: 800,
    height: 600,
  },
  {
    src: 'FACILITY/ENTRANCE_PROFILE.JPG',
    out: 'facility-entrance.webp',
    full: 1600,
    width: 800,
    height: 600,
  },
  {
    src: 'FACILITY/SIDE_PROFILE_2.JPG',
    out: 'facility-lanes.webp',
    full: 1600,
    width: 800,
    height: 600,
  },
  {
    src: 'FACILITY/SIDE_PROFILE_1.JPG',
    out: 'facility-main-pool.webp',
    full: 1600,
    width: 800,
    height: 600,
  },
  {
    src: 'FACILITY/SECONDARY_POOL.JPG',
    out: 'facility-secondary-pool.webp',
    full: 1600,
    width: 800,
    height: 600,
  },
  {
    src: 'FACILITY/FRONT_ON_DIVEBOARDS.JPG',
    out: 'facility-blocks.webp',
    full: 1600,
    width: 800,
    height: 600,
  },
  { src: 'HEATED_POOL.JPG', out: 'facility-heated-pool.webp',
    full: 1600, width: 800,
    height: 600 },

  // ---- Values ----
  // The quiet reflection shot: too still to sell a lesson, but it carries a
  // "process over pressure" page better than another photo of a busy class.
  {
    src: 'AESTHETIC_DIVE_BOARD.JPG',
    out: 'values-hero.webp',
    width: 1600,
    height: 900,
  },

  // ---- About ----
  {
    src: 'ROSS_OVERSEEING.JPG',
    out: 'about-hero.webp',
    width: 2000,
    height: 800,
    // Ross stands tall in frame; a centred 2.5:1 crop decapitates him.
    position: 'top',
  },

  // ---- Social card ----
  // Stays JPEG: several messaging apps still won't unfurl a WebP og:image.
  {
    src: 'FACILITY/HERO_SHOT.JPG',
    out: 'og-cover.jpg',
    width: 1200,
    height: 630,
    format: 'jpeg',
  },
];

function encode(pipeline, format) {
  return format === 'jpeg'
    ? pipeline.jpeg({ quality: 82, mozjpeg: true })
    : pipeline.webp({ quality: QUALITY });
}

function source(spec) {
  // .rotate() honours EXIF orientation, and must come before extract/resize so
  // any declared crop window is in the same coordinate space as the image we saw.
  const img = sharp(path.join(SRC, spec.src)).rotate();
  return spec.extract ? img.extract(spec.extract) : img;
}

async function one(spec, width, outName) {
  if (!fs.existsSync(path.join(SRC, spec.src)))
    throw new Error(`missing source: ${spec.src}`);

  // Scale the declared height with the width so narrower srcset copies keep the
  // exact aspect ratio of the full-size one — otherwise the browser swaps in a
  // differently-shaped image at the breakpoint and the layout jumps.
  const height = Math.round((spec.height / spec.width) * width);

  const pipeline = source(spec).resize(width, height, {
    fit: 'cover',
    position: spec.position || 'centre',
  });

  const to = path.join(OUT, outName);
  await encode(pipeline, spec.format).toFile(to);
  return { to, bytes: fs.statSync(to).size, width, height };
}

/** Whole frame, uncropped, capped to `width`. Feeds the lightbox. */
async function uncropped(spec, width, outName) {
  const to = path.join(OUT, outName);
  const info = await encode(
    source(spec).resize(width, null, { withoutEnlargement: true }),
    spec.format
  ).toFile(to);
  return { to, bytes: fs.statSync(to).size, width: info.width, height: info.height };
}

const kb = (b) => `${(b / 1024).toFixed(0)}KB`;

async function main() {
  if (!fs.existsSync(SRC)) {
    throw new Error(`source folder not found:\n  ${SRC}`);
  }
  fs.mkdirSync(OUT, { recursive: true });

  let total = 0;
  for (const spec of IMAGES) {
    const main = await one(spec, spec.width, spec.out);
    total += main.bytes;
    console.log(
      `  ${spec.out.padEnd(30)} ${String(main.width).padStart(4)}x${String(main.height).padEnd(4)}  ${kb(main.bytes).padStart(6)}`
    );

    const ext = path.extname(spec.out);
    const stem = path.basename(spec.out, ext);

    for (const w of spec.widths || []) {
      const name = `${stem}-${w}${ext}`;
      const extra = await one(spec, w, name);
      total += extra.bytes;
      console.log(
        `  ${name.padEnd(30)} ${String(extra.width).padStart(4)}x${String(extra.height).padEnd(4)}  ${kb(extra.bytes).padStart(6)}`
      );
    }

    if (spec.full) {
      const name = `${stem}-full${ext}`;
      const big = await uncropped(spec, spec.full, name);
      total += big.bytes;
      console.log(
        `  ${name.padEnd(30)} ${String(big.width).padStart(4)}x${String(big.height).padEnd(4)}  ${kb(big.bytes).padStart(6)}`
      );
    }
  }
  console.log(`\n${IMAGES.length} sources -> ${kb(total)} total.`);
}

main().catch((err) => {
  console.error(`\nImage build failed: ${err.message}\n`);
  process.exit(1);
});
