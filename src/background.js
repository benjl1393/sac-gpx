/**
 * Service worker.
 *
 * It exists for exactly one reason: the elevation service lives on another
 * origin, and a content script's fetches are bound by the page's CORS policy.
 * The worker's fetches run with the extension's host permissions instead, so
 * this is the only place the swisstopo call can be made from.
 *
 * Everything else deliberately stays out of here — MV3 workers are evicted
 * aggressively, so route state and file writing belong in contexts that live
 * as long as the user's attention does.
 */

import { enrichSegments } from './lib/elevation.js';

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'sac-gpx:elevations') return false;

  enrichSegments(message.segments)
    .then((segments) => {
      sendResponse({
        ok: true,
        elevations: segments.map((segment) => segment.elevations),
      });
    })
    .catch((error) => {
      console.warn('[sac-gpx] elevation enrichment failed', error);
      sendResponse({ ok: false, error: String(error?.message || error) });
    });

  // Keep the message channel open for the async response.
  return true;
});
