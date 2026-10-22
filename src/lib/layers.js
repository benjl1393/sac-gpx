/**
 * swisstopo WMTS layers.
 *
 * Verified 2026-08-20: every layer below returns HTTP 200 with no API key and
 * `Access-Control-Allow-Origin: *`. swisstopo publishes these as open
 * government data; attribution is required and is rendered in the viewer.
 */

const WMTS = 'https://wmts.geo.admin.ch/1.0.0';

const tileUrl = (layer, format) => (z, x, y) =>
  `${WMTS}/${layer}/default/current/3857/${z}/${x}/${y}.${format}`;

export const BASE_LAYERS = [
  {
    id: 'pixelkarte',
    label: 'National map',
    url: tileUrl('ch.swisstopo.pixelkarte-farbe', 'jpeg'),
  },
  {
    id: 'swissimage',
    label: 'Aerial',
    url: tileUrl('ch.swisstopo.swissimage', 'jpeg'),
  },
];

/**
 * The backdrop for the popup's small preview.
 *
 * Shaded relief from swissALTI3D rather than the national map: at the zoom a
 * 324x150 plate forces, the national map's place names and spot heights are
 * sized for a full sheet and shout over a 3px route line. Relief carries the
 * landform — which is what "not an empty background" actually needs — and
 * carries no type at all.
 */
export const PREVIEW_LAYER = {
  id: 'relief',
  label: 'Relief',
  url: tileUrl('ch.swisstopo.swissalti3d-reliefschattierung', 'png'),
};

export const OVERLAY_LAYERS = [
  {
    id: 'slope',
    label: 'Slope 30°+',
    hint: 'swisstopo slope classes, banded per SLF recommendation.',
    url: tileUrl('ch.swisstopo.hangneigung-ueber_30', 'png'),
    // 0.6 buried the contours and place names underneath, and put saturated
    // red next to the red route line. At 0.4 the bands still read clearly as
    // bands while the map beneath stays navigable.
    opacity: 0.4,
    defaultFor: ['ski_tour', 'snowshoe_tour'],
  },
  {
    id: 'skitouren',
    label: 'Ski routes',
    hint: 'The official ski touring route network.',
    url: tileUrl('ch.swisstopo-karto.skitouren', 'png'),
    opacity: 0.9,
    // Deliberately not on by default: shown together with the slope classes it
    // is one layer too many, and the SAC line is the subject here.
    defaultFor: [],
  },
  {
    id: 'wanderwege',
    label: 'Hiking paths',
    hint: 'The signposted hiking network from swissTLM3D.',
    url: tileUrl('ch.swisstopo.swisstlm3d-wanderwege', 'png'),
    opacity: 0.9,
    defaultFor: ['mountain_hiking'],
  },
];

export const ATTRIBUTION = '© swisstopo · route data © SAC/CAS';

/**
 * The slope layer's own colours, sampled from the rendered tiles rather than
 * guessed, so the legend cannot drift from the map. Without this the layer is
 * a wash of unexplained colour — which for a ski tourer is the whole point of
 * turning it on.
 */
export const SLOPE_LEGEND = [
  { colour: '#f2e50a', label: '30–35°' },
  { colour: '#f46f24', label: '35–40°' },
  { colour: '#de055b', label: '40–45°' },
  { colour: '#c889bb', label: '45°+' },
];

/** Overlays that should start enabled for a given SAC discipline. */
export function defaultOverlaysFor(discipline) {
  return OVERLAY_LAYERS.filter((layer) => layer.defaultFor.includes(discipline)).map((l) => l.id);
}
