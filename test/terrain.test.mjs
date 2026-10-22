import test from 'node:test';
import assert from 'node:assert/strict';

import { steepSections, summarise, SLOPE_BANDS, SAMPLE_OFFSET } from '../src/lib/terrain.js';

/** Build a terrain array from a list of slopes, all facing one way. */
const terrainOf = (slopes, cardinal = 'N') =>
  slopes.map((slope) => (slope === null ? null : { slope, aspect: 0, cardinal }));

/** A straight line, 10 m between points, matching the terrain array length. */
const lineOf = (n) => Array.from({ length: n }, (_, i) => [2600000 + i * 10, 1200000]);

test('steepSections finds a contiguous run above the threshold', () => {
  const terrain = terrainOf([10, 12, 34, 36, 38, 15, 11]);
  const sections = steepSections(lineOf(7), terrain);

  assert.equal(sections.length, 1);
  assert.equal(sections[0].startIndex, 2);
  assert.equal(sections[0].endIndex, 4);
  assert.equal(Math.round(sections[0].maxSlope), 38);
  assert.equal(Math.round(sections[0].length), 20);
});

test('steepSections ignores excursions shorter than minPoints', () => {
  // A single 40° sample between gentle ground is terrain-model noise,
  // not a steep section.
  const sections = steepSections(lineOf(5), terrainOf([10, 10, 40, 10, 10]));
  assert.equal(sections.length, 0);
});

test('steepSections separates runs divided by gentle ground', () => {
  const terrain = terrainOf([35, 35, 35, 10, 10, 36, 37, 38]);
  const sections = steepSections(lineOf(8), terrain);
  assert.equal(sections.length, 2);
  assert.deepEqual([sections[0].startIndex, sections[0].endIndex], [0, 2]);
  assert.deepEqual([sections[1].startIndex, sections[1].endIndex], [5, 7]);
});

test('steepSections closes a run that reaches the end of the track', () => {
  const sections = steepSections(lineOf(4), terrainOf([10, 33, 34, 35]));
  assert.equal(sections.length, 1);
  assert.equal(sections[0].endIndex, 3);
});

test('steepSections honours a custom threshold', () => {
  const terrain = terrainOf([32, 33, 34]);
  assert.equal(steepSections(lineOf(3), terrain, { threshold: 30 }).length, 1);
  assert.equal(steepSections(lineOf(3), terrain, { threshold: 40 }).length, 0);
});

test('steepSections reports the dominant aspect of the run', () => {
  const terrain = [
    { slope: 35, aspect: 0, cardinal: 'N' },
    { slope: 36, aspect: 0, cardinal: 'NE' },
    { slope: 37, aspect: 0, cardinal: 'NE' },
    { slope: 38, aspect: 0, cardinal: 'NE' },
  ];
  const [section] = steepSections(lineOf(4), terrain);
  assert.equal(section.dominantAspect, 'NE');
});

test('summarise reports max slope, bands and steep aspects', () => {
  const terrain = terrainOf([10, 31, 36, 41, 46], 'SE');
  const sections = steepSections(lineOf(5), terrain);
  const summary = summarise(terrain, sections);

  assert.equal(Math.round(summary.maxSlope), 46);
  assert.equal(summary.coverage, 1);
  assert.deepEqual(summary.bands.map((b) => b.label), ['30–35°', '35–40°', '40–45°', '45°+']);
  assert.deepEqual(summary.steepAspects, ['SE']);
});

test('summarise reports partial coverage when the model has gaps', () => {
  const summary = summarise(terrainOf([20, null, null, 20]), []);
  assert.equal(summary.coverage, 0.5);
});

test('summarise returns null when nothing resolved', () => {
  assert.equal(summarise([null, null], []), null);
});

test('slope bands start at 30 degrees, matching the swisstopo layer', () => {
  assert.equal(SLOPE_BANDS[0].from, 30);
  assert.equal(SLOPE_BANDS.at(-1).to, Infinity);
  for (let i = 1; i < SLOPE_BANDS.length; i++) {
    assert.equal(SLOPE_BANDS[i].from, SLOPE_BANDS[i - 1].to, 'bands must not leave gaps');
  }
});

test('sample offset is documented and sane', () => {
  assert.ok(SAMPLE_OFFSET >= 10 && SAMPLE_OFFSET <= 50);
});
