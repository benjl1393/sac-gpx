/**
 * Preflight checks for the packaged extension.
 *
 * These catch the failures that only surface at "Load unpacked" — a manifest
 * pointing at a file that does not exist, an import specifier that resolves
 * nowhere, a dynamically-imported module missing from web_accessible_resources.
 * None of them are visible to the unit tests, and all of them are silent until
 * Chrome refuses to load the extension or a content script dies at runtime.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, relative } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(resolve(root, 'manifest.json'), 'utf8'));

const exists = (p) => existsSync(resolve(root, p));

test('manifest declares MV3 and required fields', () => {
  assert.equal(manifest.manifest_version, 3);
  assert.ok(manifest.name);
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.ok(manifest.description);
});

test('every file the manifest references exists', () => {
  const referenced = [
    ...Object.values(manifest.icons ?? {}),
    ...Object.values(manifest.action?.default_icon ?? {}),
    manifest.action?.default_popup,
    manifest.background?.service_worker,
    ...(manifest.content_scripts ?? []).flatMap((cs) => [...(cs.js ?? []), ...(cs.css ?? [])]),
  ].filter(Boolean);

  for (const file of referenced) {
    assert.ok(exists(file), `manifest references missing file: ${file}`);
  }
});

test('service worker is a module, since the libs use ESM', () => {
  assert.equal(manifest.background.type, 'module');
});

test('host permissions cover both origins the extension talks to', () => {
  const hosts = manifest.host_permissions ?? [];
  assert.ok(hosts.some((h) => h.includes('sac-cas.ch')), 'missing sac-cas.ch');
  assert.ok(hosts.some((h) => h.includes('api3.geo.admin.ch')), 'missing swisstopo');
});

test('no downloads permission — the file is written from page context', () => {
  assert.ok(
    !(manifest.permissions ?? []).includes('downloads'),
    'downloads permission crept back in; the blob-URL path makes it unnecessary'
  );
});

test('libs dynamically imported by the content script are web-accessible', () => {
  const content = readFileSync(resolve(root, 'src/content.js'), 'utf8');
  const dynamic = [...content.matchAll(/import\(`\$\{base\}(\w+\.js)`\)/g)].map((m) => m[1]);
  assert.ok(dynamic.length >= 2, 'expected the content script to import libs dynamically');

  const patterns = manifest.web_accessible_resources.flatMap((r) => r.resources);
  for (const file of dynamic) {
    assert.ok(exists(`src/lib/${file}`), `content.js imports missing lib: ${file}`);
    assert.ok(
      patterns.some((p) => p === `src/lib/${file}` || p === 'src/lib/*.js'),
      `src/lib/${file} is imported by the content script but not web-accessible`
    );
  }
});

test('every static import in src/ resolves to a real file', () => {
  const sources = [
    'src/background.js',
    'src/content.js',
    'src/popup/popup.js',
    'src/lib/swiss.js',
    'src/lib/sac.js',
    'src/lib/orient.js',
    'src/lib/gpx.js',
    'src/lib/elevation.js',
    'src/lib/render.js',
  ];

  for (const source of sources) {
    const code = readFileSync(resolve(root, source), 'utf8');
    for (const match of code.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
      const target = resolve(root, dirname(source), match[1]);
      assert.ok(
        existsSync(target),
        `${source} imports ${match[1]} which does not exist (${relative(root, target)})`
      );
    }
  }
});

test('extension pages reference files that exist, relative to themselves', () => {
  for (const page of ['src/popup/popup.html', 'src/map/map.html']) {
    const html = readFileSync(resolve(root, page), 'utf8');
    for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
      const target = resolve(root, dirname(page), match[1]);
      assert.ok(existsSync(target), `${page} references missing ${match[1]}`);
    }
  }
});

test('the map page is reachable and its imports resolve', () => {
  assert.ok(existsSync(resolve(root, 'src/map/map.html')));
  const code = readFileSync(resolve(root, 'src/map/map.js'), 'utf8');
  for (const match of code.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
    assert.ok(
      existsSync(resolve(root, 'src/map', match[1])),
      `map.js imports ${match[1]} which does not exist`
    );
  }
});

test('map tile layers are https and carry no api key', () => {
  const code = readFileSync(resolve(root, 'src/lib/layers.js'), 'utf8');
  assert.match(code, /https:\/\/wmts\.geo\.admin\.ch/);
  assert.ok(!/[?&](key|apikey|token)=/i.test(code), 'a credential crept into a tile url');
  assert.match(code, /swisstopo/, 'attribution string must name the source');
});

test('css font urls resolve from their stylesheet', () => {
  for (const sheet of ['src/content.css', 'src/popup/popup.css']) {
    const css = readFileSync(resolve(root, sheet), 'utf8');
    for (const match of css.matchAll(/url\(['"]?([^'")]+\.woff2)['"]?\)/g)) {
      const target = resolve(root, dirname(sheet), match[1]);
      assert.ok(existsSync(target), `${sheet} references missing font ${match[1]}`);
    }
  }
});

test('fonts used by the content script are web-accessible', () => {
  const patterns = manifest.web_accessible_resources.flatMap((r) => r.resources);
  assert.ok(
    patterns.some((p) => p.startsWith('src/fonts/')),
    'content.css loads a bundled font, so it must be web-accessible'
  );
});

test('popup delegates SAC access rather than fetching the portal itself', () => {
  // The popup is allowed to *check* the active tab's URL — that is how it knows
  // whether to offer an export. What it must never do is import the SAC api
  // module or issue its own request, because the authenticated fetch only works
  // same-origin from the content script.
  const popup = readFileSync(resolve(root, 'src/popup/popup.js'), 'utf8');

  assert.ok(
    !/from\s+['"][^'"]*lib\/sac\.js['"]/.test(popup),
    'popup must not import lib/sac.js; the content script owns portal access'
  );

  const code = popup.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.ok(
    !/\bfetch\s*\(/.test(code),
    'popup must not call fetch; it messages the content script and service worker'
  );
});
