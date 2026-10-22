/**
 * Route colour by discipline.
 *
 * SAC publishes the discipline on every route (`type`), and a ski tour and an
 * alpine route are different enough activities that drawing them in the same
 * red throws away information the payload already carries. Colouring by
 * discipline means the line says what kind of day it is before you read a word.
 *
 * The palette is constrained from three directions:
 *
 *  1. Swiss convention. Mountain hiking routes are red because that is what a
 *     Bergweg waymark is; ski touring is blue on swisstopo's own ski layer.
 *  2. The slope overlay. Its bands are yellow #f2e50a, orange #f46f24, magenta
 *     #de055b and a pale violet #c889bb. A route hue must not be mistakable for
 *     a band, which is why the alpine violet here is deep and saturated where
 *     the 45°+ band is pale — and why nothing is drawn in yellow.
 *  3. Separation from the interface blue. The UI primary is a deep indigo; ski
 *     routes are a brighter azure, so a blue button and a blue route never read
 *     as the same element.
 *
 * Luminance contrast against the bands is deliberately NOT the whole test — a
 * 3.6px line is separated from a large colour field by hue and by its white
 * casing as much as by any ratio.
 *
 * Which variant goes where matters and is easy to get backwards. The LIGHT
 * variant is for anything drawn over the national map, because those tiles are
 * pale paper regardless of how dark the surrounding interface is; the DARK
 * variant is only for the popup's preview plate when the system theme is dark,
 * where the ground really is dark. The slope bands only ever appear on the map,
 * so they are a constraint on the light variants alone.
 */

const DEFAULT = {
  id: 'default',
  label: 'Route',
  colour: '#d12b1f',
  colourDark: '#ff5a4a',
};

export const DISCIPLINES = {
  mountain_hiking: {
    id: 'mountain_hiking',
    label: 'Mountain hiking',
    colour: '#d12b1f',     // the red of a Swiss Bergweg waymark
    colourDark: '#ff5a4a',
  },
  hiking: {
    id: 'hiking',
    label: 'Hiking',
    colour: '#d12b1f',
    colourDark: '#ff5a4a',
  },
  ski_tour: {
    id: 'ski_tour',
    label: 'Ski tour',
    colour: '#0f7ae5',     // azure, matching swisstopo's ski touring layer
    colourDark: '#4aa3ff',
  },
  snowshoe_tour: {
    id: 'snowshoe_tour',
    label: 'Snowshoe tour',
    colour: '#0d7f8c',     // teal — winter, but not mistakable for a ski line
    colourDark: '#35b3c2',
  },
  alpine_tour: {
    id: 'alpine_tour',
    label: 'Alpine tour',
    colour: '#6d3bbf',     // deep violet; the 45°+ slope band is pale violet
    colourDark: '#a97bf0',
  },
  alpine_climbing: {
    id: 'alpine_climbing',
    label: 'Alpine climbing',
    colour: '#6d3bbf',
    colourDark: '#a97bf0',
  },
  climbing: {
    id: 'climbing',
    label: 'Climbing',
    colour: '#7b3fb8',
    colourDark: '#b183ea',
  },
  via_ferrata: {
    id: 'via_ferrata',
    label: 'Via ferrata',
    colour: '#a8480f',     // burnt orange, well below the slope band's brightness
    colourDark: '#e08340',
  },
  ice_climbing: {
    id: 'ice_climbing',
    label: 'Ice climbing',
    colour: '#0b6f9e',
    colourDark: '#46aad8',
  },
};

/**
 * SAC line-style notation.
 *
 * Every segment carries a `style`, and on the portal's own map it is not
 * decoration — it is the terrain grade of that leg, which is safety
 * information the description would otherwise have to carry in prose:
 *
 *   plain   hiking: no alpine requirements, up to T3, normally on a trail
 *           alpine: on a marked path or path traces
 *           ski:    the approximate itinerary
 *   dashed  hiking: higher alpine requirements, exposed passages, T4 and up
 *           alpine: on an unmarked path or path traces
 *           ski:    this leg requires increased caution
 *           climbing / via ferrata: approximate itinerary, where chartable
 *   dotted  alpine: pathless — glacier or rock, where the detailed line cannot
 *           be charted at all and the real itinerary varies
 *           ski:    normally covered on foot, from a ski depot and back
 *
 * Taken from the portal's legend and its own stylesheet, which sets
 * `stroke-dasharray: 12,4` for dashed and `4,4` for dotted on a 4px line.
 * The proportions below are those ratios re-cut for the widths drawn here,
 * with dots drawn as round caps on a zero-length dash so they read as dots
 * rather than as short dashes at map scale.
 *
 * The colours are deliberately NOT SAC's. The portal draws hiking green and
 * climbing orange-red; both would sit on top of the slope overlay's own
 * yellow-orange-magenta bands, which the palette above is built to stay clear
 * of. Line style is the half of the notation that carries terrain, so that is
 * the half adopted verbatim.
 *
 * Because dash now means terrain, it cannot also mean "variant" — variants are
 * separated by colour alone and take their pattern from `style` like any other
 * segment.
 */
export const LINE_STYLES = {
  plain: { id: 'plain', label: 'Solid' },
  dashed: { id: 'dashed', label: 'Dashed' },
  dotted: { id: 'dotted', label: 'Dotted' },
};

/** Normalise a payload `style` to one of the three the notation defines. */
export function lineStyleFor(style) {
  return LINE_STYLES[style] ? style : 'plain';
}

/**
 * What the line style means for a given discipline, for the map legend.
 * Returns null where the discipline does not use that style at all, so the
 * legend can list only the styles the route in front of you can actually show.
 */
const STYLE_MEANINGS = {
  mountain_hiking: { plain: 'On a trail, up to T3', dashed: 'Exposed or pathless, T4+' },
  hiking: { plain: 'On a trail, up to T3', dashed: 'Exposed or pathless, T4+' },
  alpine_tour: {
    plain: 'Marked path or traces',
    dashed: 'Unmarked path or traces',
    dotted: 'Pathless — line is indicative',
  },
  alpine_climbing: {
    plain: 'Marked path or traces',
    dashed: 'Approximate line of the climb',
    dotted: 'Pathless — line is indicative',
  },
  climbing: { dashed: 'Approximate line of the climb' },
  via_ferrata: { dashed: 'Approximate line of the route' },
  ski_tour: {
    plain: 'Approximate itinerary',
    dashed: 'Increased caution on this leg',
    dotted: 'On foot, from a ski depot',
  },
  snowshoe_tour: { plain: 'Approximate itinerary' },
};

export function styleMeaning(discipline, style) {
  return STYLE_MEANINGS[discipline]?.[style] ?? null;
}

/** Look up a discipline, falling back rather than throwing on an unseen type. */
export function disciplineFor(type) {
  return DISCIPLINES[type] ?? { ...DEFAULT, id: type || 'default' };
}

/** The route colour for a discipline in the given theme. */
export function routeColour(type, theme = 'light') {
  const discipline = disciplineFor(type);
  return theme === 'dark' ? discipline.colourDark : discipline.colour;
}

/** Human-readable name, for the map bar and the popup caption. */
export function disciplineLabel(type) {
  return disciplineFor(type).label;
}
