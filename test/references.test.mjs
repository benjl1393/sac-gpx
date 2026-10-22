/**
 * Guards against calling something that does not exist.
 *
 * This exists because of a real bug: removing the map's bottom strip deleted
 * renderStrip() but left the call to it in init(). Nothing caught it — the unit
 * tests never load the page modules, and a screenshot still looks correct
 * because the throw happens after the first render. What actually broke was
 * everything *after* the call: zoom, pan and the terrain pass were all dead,
 * silently, in a committed and pushed build.
 *
 * A full solution would run the modules in a DOM, which means a dependency.
 * This is the cheap version: parse each module for the functions it declares
 * and imports, then assert every function it calls is one of those or a known
 * platform global.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Platform and language globals a browser module may legitimately call. */
const GLOBALS = new Set([
  'require', 'import', 'fetch', 'setTimeout', 'clearTimeout', 'setInterval',
  'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame', 'queueMicrotask',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent',
  'decodeURIComponent', 'structuredClone', 'btoa', 'atob',
  'String', 'Number', 'Boolean', 'Array', 'Object', 'Math', 'JSON', 'Date',
  'Map', 'Set', 'WeakMap', 'WeakSet', 'Promise', 'Error', 'RegExp', 'Symbol',
  'Proxy', 'Reflect', 'BigInt', 'Intl', 'URL', 'URLSearchParams', 'Blob',
  'File', 'FormData', 'Headers', 'Request', 'Response', 'AbortController',
  'Image', 'Uint8Array', 'Float64Array', 'Int32Array',
  'MutationObserver', 'ResizeObserver', 'IntersectionObserver', 'XMLSerializer',
  'DOMParser', 'CustomEvent', 'Event', 'alert', 'confirm', 'prompt',
  'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'function',
  'await', 'super', 'this', 'new', 'do', 'else', 'try', 'yield', 'void', 'in', 'of',
  'async', 'constructor', 'get', 'set', 'class', 'delete', 'instanceof', 'export',
]);

/**
 * Strip comments and every kind of string literal.
 *
 * Without this, CSS inside a template literal reads as code — `translate(...)`
 * in a transform string looked like a call to an undefined function.
 */
function stripLiterals(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ')
    .replace(/`(?:\\.|[^`\\])*`/g, '``')
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""');
}

function moduleFiles() {
  const out = [];
  const walk = (relative) => {
    for (const entry of readdirSync(resolve(root, relative), { withFileTypes: true })) {
      const next = `${relative}/${entry.name}`;
      if (entry.isDirectory()) walk(next);
      else if (entry.name.endsWith('.js')) out.push(next);
    }
  };
  walk('src');
  return out;
}

/** Names this module declares or imports, so calling them is fine. */
function declaredNames(code) {
  const names = new Set();
  for (const m of code.matchAll(/(?:^|\n)\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of code.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g)) names.add(m[1]);
  for (const m of code.matchAll(/(?:const|let|var)\s*\{([^}]*)\}\s*=/g)) {
    for (const part of m[1].split(',')) {
      const name = part.split(':').pop().trim().replace(/\s*=.*$/, '');
      if (name) names.add(name);
    }
  }
  for (const m of code.matchAll(/import\s*\{([^}]*)\}\s*from/g)) {
    for (const part of m[1].split(',')) {
      const name = part.split(/\s+as\s+/).pop().trim();
      if (name) names.add(name);
    }
  }
  for (const m of code.matchAll(/import\s+([A-Za-z_$][\w$]*)\s+from/g)) names.add(m[1]);
  // Parameters, so a callback's own arguments do not read as undefined.
  for (const m of code.matchAll(/\(([^)]*)\)\s*(?:=>|\{)/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().replace(/\s*=.*$/, '').replace(/^\.\.\./, '');
      if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
    }
  }
  return names;
}

test('every function called is declared, imported, or a platform global', () => {
  const problems = [];

  for (const file of moduleFiles()) {
    const code = stripLiterals(readFileSync(resolve(root, file), 'utf8'));
    const declared = declaredNames(code);

    // Bare `name(` calls only — anything with a dot before it is a property
    // access and belongs to some object we cannot resolve statically.
    for (const match of code.matchAll(/(^|[^\w$.])([a-z_$][\w$]*)\s*\(/g)) {
      const name = match[2];
      if (GLOBALS.has(name) || declared.has(name)) continue;
      problems.push(`${file}: calls ${name}() which is not defined or imported`);
    }
  }

  assert.deepEqual(problems, [], `\n${problems.join('\n')}`);
});

test('the guard actually catches a dangling call', () => {
  // A checker that never fires is worse than none, so prove it on the exact
  // shape of the bug it was written for: a function removed, its call left.
  const sample = `
    import { helper } from './x.js';
    function present() { return 1; }
    function init() { present(); helper(); renderStrip(); }
  `;
  const declared = declaredNames(sample);
  const missed = [];
  for (const match of stripLiterals(sample).matchAll(/(^|[^\w$.])([a-z_$][\w$]*)\s*\(/g)) {
    const name = match[2];
    if (GLOBALS.has(name) || declared.has(name)) continue;
    missed.push(name);
  }
  assert.deepEqual(missed, ['renderStrip']);
});
