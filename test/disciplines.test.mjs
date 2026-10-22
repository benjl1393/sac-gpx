import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DISCIPLINES, disciplineFor, routeColour, disciplineLabel,
  LINE_STYLES, lineStyleFor, styleMeaning,
} from '../src/lib/disciplines.js';
import { SLOPE_LEGEND } from '../src/lib/layers.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Relative luminance, for the perceptual checks below. */
function luminance(hex) {
  const [r, g, b] = hex.replace('#', '').match(/../g).map((h) => {
    const c = parseInt(h, 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function hue(hex) {
  const [r, g, b] = hex.replace('#', '').match(/../g).map((h) => parseInt(h, 16) / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (!d) return 0;
  let h;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return ((h * 60) + 360) % 360;
}

const hueGap = (a, b) => {
  const diff = Math.abs(hue(a) - hue(b)) % 360;
  return diff > 180 ? 360 - diff : diff;
};

test('every discipline defines both theme variants and a label', () => {
  for (const [id, discipline] of Object.entries(DISCIPLINES)) {
    assert.equal(discipline.id, id, `${id} id mismatch`);
    assert.match(discipline.colour, /^#[0-9a-f]{6}$/, `${id} light colour`);
    assert.match(discipline.colourDark, /^#[0-9a-f]{6}$/, `${id} dark colour`);
    assert.ok(discipline.label?.length > 2, `${id} needs a readable label`);
  }
});

test('dark variants are lighter than their light counterparts', () => {
  // A hue that reads on paper is muddy on a dark ground; the dark variant has
  // to actually be lifted, not just different.
  for (const [id, d] of Object.entries(DISCIPLINES)) {
    assert.ok(
      luminance(d.colourDark) > luminance(d.colour),
      `${id}: dark variant ${d.colourDark} is not lighter than ${d.colour}`
    );
  }
});

test('the disciplines SAC actually publishes are all covered', () => {
  // Observed across a sample of real routes; an uncovered one silently falls
  // back to red and loses the distinction the colour is meant to carry.
  for (const type of ['mountain_hiking', 'ski_tour', 'snowshoe_tour', 'alpine_tour', 'alpine_climbing']) {
    assert.ok(DISCIPLINES[type], `${type} is unmapped`);
  }
});

test('unknown disciplines fall back instead of throwing', () => {
  const unknown = disciplineFor('paragliding');
  assert.match(unknown.colour, /^#[0-9a-f]{6}$/);
  assert.equal(disciplineLabel('paragliding'), 'Route');
  assert.equal(disciplineLabel(undefined), 'Route');
  assert.match(routeColour(null), /^#[0-9a-f]{6}$/);
});

test('routeColour honours the requested theme', () => {
  assert.equal(routeColour('ski_tour', 'light'), DISCIPLINES.ski_tour.colour);
  assert.equal(routeColour('ski_tour', 'dark'), DISCIPLINES.ski_tour.colourDark);
  assert.equal(routeColour('ski_tour'), DISCIPLINES.ski_tour.colour, 'light is the default');
});

test('ski is blue and alpine is violet, as specified', () => {
  const ski = hue(DISCIPLINES.ski_tour.colour);
  assert.ok(ski > 190 && ski < 240, `ski hue ${ski} is not blue`);

  const alpine = hue(DISCIPLINES.alpine_tour.colour);
  assert.ok(alpine > 245 && alpine < 300, `alpine hue ${alpine} is not violet`);

  const hiking = hue(DISCIPLINES.mountain_hiking.colour);
  assert.ok(hiking < 20 || hiking > 350, `hiking hue ${hiking} is not red`);
});

function contrast(a, b) {
  const la = luminance(a), lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

test('every route colour is separable from every slope band', () => {
  // An earlier version of this test demanded a 25° hue gap from all four
  // bands. That is impossible: the bands run yellow -> orange -> magenta ->
  // violet, leaving red only ~45° of room between orange at 22° and magenta at
  // 336°, so no red can clear 25° on both sides. Hue was never the whole
  // mechanism anyway — a route is a thin saturated line with a white casing,
  // a band is a large 40%-opacity wash. Separation by VALUE is just as real.
  //
  // So: each route colour must differ from each band by hue or by lightness.
  const MIN_HUE = 25;
  const MIN_CONTRAST = 1.6;

  // The LIGHT variants only, and that is the point rather than an oversight:
  // the slope layer exists solely on the map, and the map draws the route over
  // pale national-map tiles, so the light variant is what has to survive here.
  // Writing this test against the dark variants is what caught the map using
  // the wrong one.
  for (const [id, d] of Object.entries(DISCIPLINES)) {
    for (const band of SLOPE_LEGEND) {
      const gap = hueGap(d.colour, band.colour);
      const ratio = contrast(d.colour, band.colour);
      assert.ok(
        gap >= MIN_HUE || ratio >= MIN_CONTRAST,
        `${id} ${d.colour} vs ${band.label} ${band.colour}: ` +
          `${gap.toFixed(0)}° hue and ${ratio.toFixed(2)}:1 — separable by neither`
      );
    }
  }
});

test('the map draws routes with the light variant, not the dark one', () => {
  // The map chrome is dark but the tiles are pale paper. Reaching for the dark
  // variant because the surround is dark is the error this guards.
  const map = readFileSync(resolve(root, 'src/map/map.js'), 'utf8');
  const call = /routeColour\([^)]*\)/.exec(map)?.[0] ?? '';
  assert.match(call, /'light'/, `map.js uses ${call} — tiles are light`);
});

test('dark variants stay legible on the popup plate, which is where they are used', () => {
  const PLATE_DARK = '#1e2126';
  for (const [id, d] of Object.entries(DISCIPLINES)) {
    const ratio = contrast(d.colourDark, PLATE_DARK);
    assert.ok(ratio >= 3, `${id} dark ${d.colourDark} is only ${ratio.toFixed(2)}:1 on the plate`);
  }
});

test('the route line is cased, which is the third separation mechanism', () => {
  // The value/hue argument above only holds because the line is outlined in
  // near-white; without the casing a dark route over a dark band merges.
  const css = readFileSync(resolve(root, 'src/map/map.css'), 'utf8');
  const halo = /\.route-halo\s*\{[^}]*\}/.exec(css)?.[0] ?? '';
  assert.match(halo, /stroke:\s*rgba\(255,\s*255,\s*255/, 'casing must be near-white');

  const haloWidth = Number(/stroke-width:\s*([\d.]+)/.exec(halo)?.[1]);
  const lineWidth = Number(
    /\.route-line\s*\{[^}]*stroke-width:\s*([\d.]+)/.exec(css)?.[1]
  );
  assert.ok(haloWidth > lineWidth, `casing ${haloWidth} must be wider than the line ${lineWidth}`);
});

test('alpine violet is separated from the 45°+ band by hue, in both themes', () => {
  // These are the closest pair in the whole palette and the one worth naming:
  // the band is a magenta-leaning violet at ~312°, the route a blue-leaning
  // violet at ~261°. Roughly 50° apart, which is what keeps them apart — not
  // lightness, which is nearly identical in the dark theme.
  const band = SLOPE_LEGEND.find((b) => b.label === '45°+');
  for (const colour of [DISCIPLINES.alpine_tour.colour, DISCIPLINES.alpine_tour.colourDark]) {
    const gap = hueGap(colour, band.colour);
    assert.ok(gap >= 40, `alpine ${colour} is only ${gap.toFixed(0)}° from ${band.colour}`);
  }
});

test('ski blue is distinct from the interface primary', () => {
  // A blue button and a blue route line must not read as the same element.
  const css = readFileSync(resolve(root, 'src/popup/popup.css'), 'utf8');
  const brand = /--brand:\s*(#[0-9a-f]{6})/i.exec(css)?.[1];
  assert.ok(brand, 'popup.css must define --brand');

  const gap = Math.abs(luminance(brand) - luminance(DISCIPLINES.ski_tour.colour));
  assert.ok(gap > 0.05, `brand ${brand} and ski blue are too close in value (${gap.toFixed(3)})`);
});

test('the bundled font is monospace only — no proportional face survives', () => {
  const fonts = readdirSync(resolve(root, 'src/fonts')).filter((f) => /\.(woff2?|ttf|otf)$/i.test(f));
  assert.ok(fonts.length > 0, 'no fonts bundled');
  assert.ok(
    fonts.every((f) => /mono/i.test(f)),
    `a non-mono face is still bundled: ${fonts.join(', ')}`
  );

  for (const sheet of ['src/popup/popup.css', 'src/map/map.css', 'src/content.css']) {
    const css = readFileSync(resolve(root, sheet), 'utf8');
    assert.ok(!/Archivo/i.test(css), `${sheet} still references Archivo`);
    assert.ok(
      !/sans-serif/.test(css) || /monospace/.test(css),
      `${sheet} falls back to a proportional face`
    );
  }
});

// ---------------------------------------------------------- SAC line notation

test('the notation carries exactly the three styles SAC publishes', () => {
  assert.deepEqual(Object.keys(LINE_STYLES), ['plain', 'dashed', 'dotted']);
});

test('lineStyleFor falls back to plain rather than passing an unknown through', () => {
  assert.equal(lineStyleFor('dashed'), 'dashed');
  assert.equal(lineStyleFor('dotted'), 'dotted');
  assert.equal(lineStyleFor('plain'), 'plain');
  // A style the portal has not published before must not reach the stylesheet,
  // where it would silently produce an unstyled — and so solid — line.
  assert.equal(lineStyleFor('wavy'), 'plain');
  assert.equal(lineStyleFor(undefined), 'plain');
  assert.equal(lineStyleFor(null), 'plain');
});

test('styleMeaning is discipline-specific, and absent where SAC does not use it', () => {
  assert.match(styleMeaning('mountain_hiking', 'dashed'), /T4/);
  assert.match(styleMeaning('ski_tour', 'dotted'), /foot/i);
  assert.match(styleMeaning('alpine_tour', 'dotted'), /athless/);
  // Hiking has no dotted line in the SAC legend, so the key must not invent one.
  assert.equal(styleMeaning('mountain_hiking', 'dotted'), null);
  // Snowshoe tours are drawn solid only.
  assert.equal(styleMeaning('snowshoe_tour', 'dashed'), null);
  assert.equal(styleMeaning('nonsense_discipline', 'plain'), null);
});

test('every style a discipline can mean is one the notation defines', () => {
  for (const discipline of Object.keys(DISCIPLINES)) {
    for (const style of Object.keys(LINE_STYLES)) {
      const meaning = styleMeaning(discipline, style);
      if (meaning !== null) assert.equal(typeof meaning, 'string');
    }
  }
});
