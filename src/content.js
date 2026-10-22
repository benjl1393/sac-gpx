/**
 * Content script — runs on www.sac-cas.ch.
 *
 * This is the only context where the route JSON can be fetched: the request is
 * same-origin here, so the browser attaches the member session cookie itself.
 * The extension therefore never sees, stores or transmits a credential — it
 * borrows the session the user already has, and only while they are on the page.
 *
 * It also owns writing the file. A content script can mint a blob URL and click
 * an anchor in page context, which means the extension needs no `downloads`
 * permission at all.
 */

(async () => {
  const base = chrome.runtime.getURL('src/lib/');
  const [sac, gpxLib, devices] = await Promise.all([
    import(`${base}sac.js`),
    import(`${base}gpx.js`),
    import(`${base}devices.js`),
  ]);

  const BUTTON_ID = 'sac-gpx-export-button';
  let currentRouteId = null;

  /** Fetch + normalise the route for the current URL, or null if not a route page. */
  async function loadCurrentRoute() {
    const routeId = sac.routeIdFromUrl(location.href);
    if (!routeId) return null;

    const lang = document.documentElement.lang?.slice(0, 2) || 'de';
    const raw = await sac.fetchRoute(routeId, sac.LANGUAGES.includes(lang) ? lang : 'de');
    return {
      route: sac.normalise(raw),
      hasGeometry: sac.hasGeometry(raw),
    };
  }

  /** Ask the service worker for elevations; degrade quietly if it cannot help. */
  async function requestElevations(segments) {
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'sac-gpx:elevations',
        segments: segments.map((segment) => ({ coordinates: segment.coordinates })),
      });
      if (!response?.ok) return null;
      return response.elevations;
    } catch (error) {
      console.warn('[sac-gpx] could not reach the service worker', error);
      return null;
    }
  }

  /**
   * Full export path, shared by the in-page button and the popup.
   *
   * Elevation is always restored. It used to be a checkbox, but SAC publishes
   * no elevation at all, so turning it off only ever produced a strictly worse
   * file — and the one case that might justify it, swisstopo being unreachable,
   * already degrades to a flat track on its own rather than failing.
   */
  async function exportRoute({ device = 'watch' } = {}) {
    const loaded = await loadCurrentRoute();
    if (!loaded) throw new Error('This is not an SAC route page.');
    if (!loaded.hasGeometry) {
      throw new Error(
        loaded.route.availability === 'limited'
          ? 'This route is members-only and no geometry was returned. Sign in to the route portal and try again.'
          : 'This route has no mapped geometry.'
      );
    }

    const { route } = loaded;
    let segments = route.segments;

    const elevations = await requestElevations(segments);
    if (elevations) {
      segments = segments.map((segment, index) => ({
        ...segment,
        elevations: elevations[index],
      }));
    }

    // Device tailoring happens last, after elevation: thinning first would
    // throw away points before they were ever sampled, and snapping waypoints
    // needs to land them on points that survive into the file.
    const tailored = devices.applyProfile(segments, route.waypoints, device);

    const gpx = gpxLib.buildGpx({ ...route, waypoints: tailored.waypoints }, tailored.segments);
    const filename = gpxLib.gpxFilename(route);
    saveFile(gpx, filename);

    return {
      filename,
      stats: gpxLib.statsFor(tailored.segments),
      points: { before: tailored.pointsBefore, after: tailored.pointsAfter },
      route,
    };
  }

  function saveFile(text, filename) {
    const blob = new Blob([text], { type: 'application/gpx+xml' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    // Give the download a beat to start before the URL is invalidated.
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  // ---------------------------------------------------------------- in-page UI

  function injectButton() {
    if (document.getElementById(BUTTON_ID)) return;
    if (!sac.routeIdFromUrl(location.href)) return;

    const button = document.createElement('button');
    button.id = BUTTON_ID;
    button.type = 'button';
    button.className = 'sac-gpx-button';
    button.innerHTML =
      '<span class="sac-gpx-button__mark" aria-hidden="true"></span>' +
      '<span class="sac-gpx-button__label">Export GPX</span>';
    button.addEventListener('click', async () => {
      if (button.dataset.busy === '1') return;
      button.dataset.busy = '1';
      const label = button.querySelector('.sac-gpx-button__label');
      const previous = label.textContent;
      label.textContent = 'Reading terrain…';
      try {
        const { stats } = await exportRoute();
        label.textContent =
          stats.ascent != null ? `Saved · ↑${stats.ascent} m` : 'Saved';
      } catch (error) {
        label.textContent = 'Failed';
        console.error('[sac-gpx]', error);
        button.title = String(error.message || error);
      } finally {
        setTimeout(() => {
          label.textContent = previous;
          button.dataset.busy = '0';
          button.title = '';
        }, 4000);
      }
    });
    document.body.appendChild(button);
  }

  function syncToUrl() {
    const routeId = sac.routeIdFromUrl(location.href);
    if (routeId === currentRouteId) return;
    currentRouteId = routeId;
    const existing = document.getElementById(BUTTON_ID);
    if (routeId) injectButton();
    else existing?.remove();
  }

  // The portal is a single-page app in places, so URL changes do not always
  // reload the document. Poll cheaply rather than patching history methods.
  syncToUrl();
  setInterval(syncToUrl, 1000);

  // ------------------------------------------------------------ popup channel

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'sac-gpx:inspect') {
      loadCurrentRoute()
        .then((loaded) => sendResponse({ ok: true, ...serialise(loaded) }))
        .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
      return true;
    }
    if (message?.type === 'sac-gpx:export') {
      exportRoute({ device: message.device ?? 'watch' })
        .then(({ filename, stats, points }) => sendResponse({ ok: true, filename, stats, points }))
        .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
      return true;
    }
    return false;
  });

  function serialise(loaded) {
    if (!loaded) return { route: null };
    return { route: loaded.route, hasGeometry: loaded.hasGeometry };
  }
})();
