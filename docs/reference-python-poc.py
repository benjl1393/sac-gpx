#!/usr/bin/env python3
"""SAC route JSON -> GPX. Zero dependencies (stdlib only).
LV95 (EPSG:2056) -> WGS84 via swisstopo's official approximation formulas."""
import json, sys, urllib.request, urllib.parse, html

ENDPOINT = ("https://www.sac-cas.ch/de/?type=1567765346410"
            "&tx_usersaccas2020_sac2020%5BrouteId%5D={rid}&output_lang={lang}")

def lv95_to_wgs84(e, n):
    """swisstopo approximate formulas; accuracy ~0.1 m. Returns (lat, lon)."""
    y = (e - 2600000.0) / 1000000.0
    x = (n - 1200000.0) / 1000000.0
    lon = (2.6779094 + 4.728982*y + 0.791484*y*x + 0.1306*y*x*x - 0.0436*y**3)
    lat = (16.9023892 + 3.238272*x - 0.270978*y*y - 0.002528*x*x
           - 0.0447*y*y*x - 0.0140*x**3)
    return lat * 100/36, lon * 100/36

def fetch(rid, lang="en"):
    req = urllib.request.Request(
        ENDPOINT.format(rid=rid, lang=lang),
        headers={"User-Agent": "Mozilla/5.0", "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())

def esc(s):
    return html.escape(str(s or ""), quote=True)

def to_gpx(d):
    name = f'{(d.get("destination_poi") or {}).get("display_name","")} ({d.get("title","")})'.strip()
    out = ['<?xml version="1.0" encoding="UTF-8"?>',
           '<gpx version="1.1" creator="sac2gpx" xmlns="http://www.topografix.com/GPX/1/1">',
           f'  <metadata><name>{esc(name)}</name><desc>{esc(d.get("teaser"))}</desc></metadata>']

    # waypoints: departure -> intermediate -> destination
    wps = [d.get("departure_point")] + \
          [w.get("reference_poi") for w in (d.get("waypoints") or [])] + \
          [d.get("destination_poi")]
    for wp in wps:
        if not wp or not wp.get("geom"): continue
        e, n = wp["geom"]["coordinates"][:2]
        lat, lon = lv95_to_wgs84(e, n)
        ele = f'<ele>{wp["altitude"]}</ele>' if wp.get("altitude") is not None else ""
        out.append(f'  <wpt lat="{lat:.7f}" lon="{lon:.7f}">{ele}'
                   f'<name>{esc(wp.get("display_name"))}</name></wpt>')

    for seg in (d.get("segments") or []):
        g = seg.get("geom")
        if not g or not g.get("coordinates"): continue
        out.append(f'  <trk><name>{esc(seg.get("title"))}</name>'
                   f'<desc>{esc(seg.get("description"))}</desc><trkseg>')
        for c in g["coordinates"]:
            lat, lon = lv95_to_wgs84(c[0], c[1])
            out.append(f'    <trkpt lat="{lat:.7f}" lon="{lon:.7f}"/>')
        out.append('  </trkseg></trk>')
    out.append('</gpx>')
    return "\n".join(out)

if __name__ == "__main__":
    rid = sys.argv[1] if len(sys.argv) > 1 else "207"
    data = fetch(rid)
    if not data.get("segments"):
        sys.exit(f"No geometry: availability={data.get('availability')!r} "
                 f"(login required — this is where the extension earns its keep)")
    gpx = to_gpx(data)
    path = f"SAC-{rid}.gpx"
    open(path, "w").write(gpx)
    pts = sum(len(s['geom']['coordinates']) for s in data['segments'] if s.get('geom'))
    print(f"wrote {path}  segments={len(data['segments'])} trkpts={pts}")
