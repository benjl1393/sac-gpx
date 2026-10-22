/**
 * SAC Tourenportal route API.
 *
 * The portal renders routes from a TYPO3 AJAX endpoint that returns the full
 * route as JSON, including GeoJSON LineString geometry in LV95. There is no
 * documented API; `TYPE_NUM` is the TYPO3 typeNum for the route handler and is
 * the one value here that could change under us — `fetchRoute` fails loudly if
 * the response stops looking like a route.
 *
 * Access is gated by the payload's own `availability` field:
 *   "free"    -> full payload, no login needed
 *   "limited" -> `segments` omitted entirely unless the request carries a
 *                member session cookie
 * This is why extraction runs in a content script on www.sac-cas.ch: the fetch
 * is same-origin, so the session cookie is attached by the browser and the
 * extension never touches a credential.
 */

import { orientSegments } from './orient.js';
import { lineStyleFor } from './disciplines.js';

const TYPE_NUM = '1567765346410';
export const SAC_ORIGIN = 'https://www.sac-cas.ch';

/** Languages the portal will render descriptions in. */
export const LANGUAGES = ['de', 'fr', 'it', 'en'];

/** Build the JSON endpoint URL for a route id. */
export function routeEndpoint(routeId, lang = 'de') {
  const params = new URLSearchParams({
    type: TYPE_NUM,
    'tx_usersaccas2020_sac2020[routeId]': String(routeId),
    output_lang: lang,
  });
  return `${SAC_ORIGIN}/de/?${params}`;
}

/**
 * The portal path segment is translated, so it cannot be matched against the
 * English slug alone — a German visitor never sees `/sac-route-portal/`. These
 * are the four published variants, read off the `hreflang` alternates the
 * portal emits on every route page. If SAC adds a language, its segment goes
 * here; nothing else in the extension is language-bound.
 */
export const PORTAL_PATH_SEGMENTS = [
  'sac-route-portal', // en
  'sac-tourenportal', // de
  'portail-des-courses-du-cas', // fr
  'portale-escursionistico-del-cas', // it
];

/**
 * Pull the numeric route id out of a route portal URL.
 * Route URLs end in a slug whose final hyphen-separated token is the id, e.g.
 *   /en/huts-and-tours/sac-route-portal/<place>/mountain-hiking/<slug>-207/
 *   /de/huetten-und-touren/sac-tourenportal/<place>/hochtouren/<slug>-207/
 * Returns null when the URL is not a route page.
 */
export function routeIdFromUrl(url) {
  let path;
  try {
    path = new URL(url).pathname;
  } catch {
    return null;
  }

  const segments = path.split('/').filter(Boolean);
  const portalIndex = segments.findIndex((segment) =>
    PORTAL_PATH_SEGMENTS.includes(segment)
  );
  if (portalIndex === -1) return null;

  // Search only below the portal root, so a numeric id in the language or
  // section segment can never be mistaken for a route.
  for (let i = segments.length - 1; i > portalIndex; i--) {
    const match = /-(\d+)$/.exec(segments[i]);
    // Hut ids (2147000168) also live in the path; route ids are the last
    // segment, so we take the first match walking backwards and stop.
    if (match) return match[1];
  }
  return null;
}

export class SacError extends Error {
  constructor(message, { code = 'sac_error' } = {}) {
    super(message);
    this.name = 'SacError';
    this.code = code;
  }
}

/** Fetch and validate a route payload. Must run same-origin on www.sac-cas.ch. */
export async function fetchRoute(routeId, lang = 'de') {
  const response = await fetch(routeEndpoint(routeId, lang), {
    credentials: 'include',
    headers: { Accept: 'application/json' },
  });

  if (!response.ok) {
    throw new SacError(`Route endpoint returned HTTP ${response.status}`, {
      code: 'http_error',
    });
  }

  let data;
  try {
    data = await response.json();
  } catch {
    throw new SacError(
      'Route endpoint did not return JSON — the portal API may have changed.',
      { code: 'not_json' }
    );
  }

  if (!data || typeof data !== 'object' || data.id === undefined) {
    throw new SacError(
      'Unexpected response shape — the portal API may have changed.',
      { code: 'bad_shape' }
    );
  }
  return data;
}

/** Does this payload actually carry usable geometry? */
export function hasGeometry(route) {
  return (route?.segments ?? []).some(
    (segment) => segment?.geom?.coordinates?.length > 0
  );
}

/**
 * Normalise a raw payload into the shape the rest of the extension uses.
 * Everything downstream (preview, GPX, popup) reads this, never the raw JSON.
 */
export function normalise(route) {
  const segments = (route.segments ?? [])
    .filter((segment) => segment?.geom?.coordinates?.length > 0)
    .map((segment) => ({
      id: segment.id,
      title: segment.title || '',
      description: stripHtml(segment.description || ''),
      discipline: segment.discipline || route.type || '',
      isVariant: Boolean(segment.alternative),
      // The portal's own terrain notation. Kept as the payload's own vocabulary
      // rather than being resolved to a dash pattern here, because the two
      // surfaces that draw it use different line widths.
      style: lineStyleFor(segment.style),
      coordinates: segment.geom.coordinates.map(([e, n]) => [e, n]),
    }));

  const waypoints = [
    labelPoi(route.departure_point, 'Start'),
    ...(route.waypoints ?? []).map((w) => labelPoi(w.reference_poi, 'Waypoint')),
    labelPoi(route.destination_poi, 'Summit / hut'),
    labelPoi(route.end_point, 'End'),
  ].filter(Boolean);

  // De-duplicate: departure and end point are frequently the same POI.
  const seen = new Set();
  const uniqueWaypoints = waypoints.filter((w) => {
    const key = `${w.easting.toFixed(1)},${w.northing.toFixed(1)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const departure = uniqueWaypoints.find((w) => w.role === 'Start') ?? null;
  const destination =
    uniqueWaypoints.find((w) => w.role === 'Summit / hut') ?? null;

  return {
    id: route.id,
    title: route.title || '',
    teaser: stripHtml(route.teaser || ''),
    availability: route.availability || 'unknown',
    discipline: route.type || '',
    season: route.discipline_season || '',
    days: route.days ?? null,
    difficulty: route.main_difficulty || '',
    seriousness: route.seriousness ?? null,
    author: route.author?.full_name || '',
    book: route.book ? `${route.book.title} (${route.book.year})` : '',
    facts: (route.route_info?.list ?? []).map((item) => ({
      label: item.label || '',
      value: item.value || '',
    })),
    destination: route.destination_poi?.display_name || '',
    segments: orientSegments(segments, { departure, destination }),
    waypoints: uniqueWaypoints,
  };
}

function labelPoi(poi, role) {
  const coordinates = poi?.geom?.coordinates;
  if (!coordinates || coordinates.length < 2) return null;
  return {
    name: poi.display_name || role,
    role,
    altitude: typeof poi.altitude === 'number' ? poi.altitude : null,
    easting: coordinates[0],
    northing: coordinates[1],
  };
}

/** Descriptions arrive as light HTML; GPX wants plain text. */
export function stripHtml(value) {
  return String(value)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
