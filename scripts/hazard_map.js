#!/usr/bin/env node
/**
 * The club's hazard map, from Google My Maps to the website.
 *
 * The Safety Committee keeps the lanes, hazards and swim areas in a Google
 * My Map ("Lake Housatonic Navigation"). Google can export it as KML, but the
 * website cannot read that export directly - Google does not let other sites
 * fetch it from a browser - and a My Map cannot show live data such as the
 * wind. So the KML is converted here into a small JSON file the website
 * draws itself, with the wind on top. The committee keeps editing the map in
 * Google, exactly as now.
 *
 *   node scripts/hazard_map.js <map.kml> <out.json>
 *
 * The map's KML: https://www.google.com/maps/d/kml?mid=<map id>&forcekml=1
 *
 * Nothing is written unless the KML really is the map (lanes and hazards
 * found), so an error page from Google can never replace a good copy.
 *
 * No dependencies: a small XML reader that handles what KML uses (elements,
 * attributes, text, CDATA, entities, comments).
 */

'use strict';

const fs = require('fs');

const MAP_ID = '1dNR4qbbp2I8oIZK2ZMMKCNkksLDCXIk';
const MAP_VIEW_URL = `https://www.google.com/maps/d/viewer?mid=${MAP_ID}`;

// ── A small XML reader ───────────────────────────────────────────────────────

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g, (m, e) => {
    if (e[0] !== '#') return ENTITIES[e];
    const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isFinite(n) && n > 0 && n <= 0x10FFFF ? String.fromCodePoint(n) : m;
  });
}

/** The end of a tag starting at `lt`: the first '>' outside a quoted attribute value. */
function tagEnd(text, lt) {
  let quote = null;
  for (let i = lt + 1; i < text.length; i++) {
    const c = text[i];
    if (quote) { if (c === quote) quote = null; }
    else if (c === '"' || c === "'") quote = c;
    else if (c === '>') return i;
  }
  throw new Error('unclosed tag');
}

/** XML text -> { name, attrs, children, text }, with names stripped of any namespace prefix. */
function parseXml(text) {
  const root = { name: '#root', attrs: {}, children: [], text: '' };
  const stack = [root];
  const top = () => stack[stack.length - 1];
  let i = 0;
  text = String(text).replace(/^﻿/, '');
  while (i < text.length) {
    const lt = text.indexOf('<', i);
    if (lt < 0) { top().text += decodeEntities(text.slice(i)); break; }
    if (lt > i) top().text += decodeEntities(text.slice(i, lt));
    if (text.startsWith('<!--', lt)) {
      const e = text.indexOf('-->', lt + 4);
      if (e < 0) throw new Error('unclosed comment');
      i = e + 3;
    } else if (text.startsWith('<![CDATA[', lt)) {
      const e = text.indexOf(']]>', lt + 9);
      if (e < 0) throw new Error('unclosed CDATA');
      top().text += text.slice(lt + 9, e);
      i = e + 3;
    } else if (text.startsWith('<?', lt)) {
      const e = text.indexOf('?>', lt + 2);
      if (e < 0) throw new Error('unclosed declaration');
      i = e + 2;
    } else if (text.startsWith('<!', lt)) {
      i = tagEnd(text, lt) + 1;                       // a DOCTYPE: nothing in it is needed
    } else {
      const gt = tagEnd(text, lt);
      const raw = text.slice(lt + 1, gt).trim();
      if (raw[0] === '/') {
        const name = raw.slice(1).trim().replace(/^[^:]*:/, '');
        const el = stack.pop();
        if (stack.length === 0 || el.name !== name) throw new Error(`mismatched </${name}>`);
      } else {
        const selfClosing = raw.endsWith('/');
        const body = selfClosing ? raw.slice(0, -1) : raw;
        const m = /^([^\s/>]+)/.exec(body);
        if (!m) throw new Error('a tag without a name');
        const attrs = {};
        for (const a of body.slice(m[1].length).matchAll(/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
          attrs[a[1].replace(/^[^:]*:/, '')] = decodeEntities(a[2] !== undefined ? a[2] : a[3]);
        }
        const el = { name: m[1].replace(/^[^:]*:/, ''), attrs, children: [], text: '' };
        top().children.push(el);
        if (!selfClosing) stack.push(el);
      }
      i = gt + 1;
    }
  }
  if (stack.length !== 1) throw new Error(`unclosed <${top().name}>`);
  return root;
}

const kids = (el, name) => (el ? el.children.filter((c) => c.name === name) : []);
const kid = (el, name) => kids(el, name)[0] || null;
const textOf = (el) => (el ? el.text.trim() : '');
function descendants(el, name, out = []) {
  for (const c of el ? el.children : []) {
    if (c.name === name) out.push(c);
    descendants(c, name, out);
  }
  return out;
}

// ── KML ──────────────────────────────────────────────────────────────────────

/** KML colours are aabbggrr: -> { color: '#RRGGBB', opacity }. */
function kmlColor(v) {
  const m = /^\s*([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})\s*$/.exec(String(v || ''));
  if (!m) return null;
  return { color: `#${m[4]}${m[3]}${m[2]}`.toUpperCase(), opacity: Math.round(parseInt(m[1], 16) / 255 * 100) / 100 };
}

/** "lon,lat[,alt] lon,lat ..." -> [[lat, lon], ...], rounded to 7 decimals; anything unreadable throws. */
function coordinates(text) {
  const out = [];
  for (const t of String(text).trim().split(/\s+/).filter(Boolean)) {
    const [lon, lat] = t.split(',').map(Number);
    if (!(Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) {
      throw new Error(`not a coordinate: "${t.slice(0, 40)}"`);
    }
    out.push([Math.round(lat * 1e7) / 1e7, Math.round(lon * 1e7) / 1e7]);
  }
  return out;
}

/**
 * A description as plain text: Google My Maps stores plain text, but may add
 * <br> for line breaks; any other markup is dropped, never passed on.
 */
function plainText(s) {
  return decodeEntities(String(s || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, ''))
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

/** The KML of a My Map -> { name, source, copied, folders: [{ name, features: [...] }] }. */
function kmlToMap(kmlText, meta = {}) {
  const root = parseXml(kmlText);
  const kml = kid(root, 'kml');
  const doc = kid(kml, 'Document');
  if (!kml || !doc) throw new Error('not a KML document');

  const styles = {}, styleMaps = {};
  for (const s of descendants(doc, 'Style')) {
    if (!s.attrs.id) continue;
    const icon = kid(s, 'IconStyle'), line = kid(s, 'LineStyle'), poly = kid(s, 'PolyStyle');
    styles[s.attrs.id] = {
      icon: icon ? kmlColor(textOf(kid(icon, 'color'))) : null,
      line: line ? Object.assign({ width: Number(textOf(kid(line, 'width'))) || 1 }, kmlColor(textOf(kid(line, 'color')))) : null,
      poly: poly ? Object.assign({ fill: textOf(kid(poly, 'fill')) !== '0', outline: textOf(kid(poly, 'outline')) !== '0' },
        kmlColor(textOf(kid(poly, 'color')))) : null,
    };
  }
  for (const m of descendants(doc, 'StyleMap')) {
    const normal = kids(m, 'Pair').find((p) => textOf(kid(p, 'key')) === 'normal');
    if (m.attrs.id && normal) styleMaps[m.attrs.id] = textOf(kid(normal, 'styleUrl'));
  }
  const styleFor = (url) => {
    let id = String(url || '').replace(/^#/, '');
    for (let n = 0; n < 5 && styleMaps[id] !== undefined; n++) id = styleMaps[id].replace(/^#/, '');
    return styles[id] || null;
  };

  const feature = (pm) => {
    const name = textOf(kid(pm, 'name'));
    const description = plainText(kid(pm, 'description') ? kid(pm, 'description').text : '');
    const st = styleFor(textOf(kid(pm, 'styleUrl')));
    const point = kid(pm, 'Point'), poly = kid(pm, 'Polygon'), line = kid(pm, 'LineString');
    if (point) {
      const c = coordinates(textOf(kid(point, 'coordinates')));
      if (c.length !== 1) throw new Error(`"${name}": a point needs one coordinate`);
      return { name, description, type: 'point', coords: c[0], color: (st && st.icon && st.icon.color) || '#E65100' };
    }
    if (poly) {
      const ring = coordinates(textOf(kid(kid(kid(poly, 'outerBoundaryIs'), 'LinearRing'), 'coordinates')));
      if (ring.length < 4) throw new Error(`"${name}": a polygon needs at least 4 points`);
      const ln = st && st.line, pf = st && st.poly;
      return { name, description, type: 'polygon', coords: ring,
        color: (ln && ln.color) || (pf && pf.color) || '#3388FF', weight: (ln && ln.width) || 1,
        fillColor: (pf && pf.color) || (ln && ln.color) || '#3388FF',
        fillOpacity: pf ? (pf.fill ? pf.opacity : 0) : 0.3, outline: pf ? pf.outline : true };
    }
    if (line) {
      const c = coordinates(textOf(kid(line, 'coordinates')));
      if (c.length < 2) throw new Error(`"${name}": a line needs at least 2 points`);
      const ln = st && st.line;
      return { name, description, type: 'line', coords: c, color: (ln && ln.color) || '#3388FF', weight: (ln && ln.width) || 2 };
    }
    return null;                                     // a kind this map does not use: left out
  };

  const folders = [];
  const loose = kids(doc, 'Placemark').map(feature).filter(Boolean);
  if (loose.length) folders.push({ name: textOf(kid(doc, 'name')) || 'Map', features: loose });
  for (const f of kids(doc, 'Folder')) {
    const features = descendants(f, 'Placemark').map(feature).filter(Boolean);
    folders.push({ name: textOf(kid(f, 'name')), features });
  }
  return {
    name: textOf(kid(doc, 'name')),
    source: meta.source || MAP_VIEW_URL,
    copied: meta.copied || new Date().toISOString().slice(0, 10),
    folders,
  };
}

/** The JSON, one feature a line: small, and a change to the map reads as a change to that line. */
function toJson(map) {
  const head = { name: map.name, source: map.source, copied: map.copied };
  const folders = map.folders.map((f) => `{"name":${JSON.stringify(f.name)},"features":[\n`
    + f.features.map((x) => JSON.stringify(x)).join(',\n') + '\n]}');
  return JSON.stringify(head).slice(0, -1) + ',"folders":[\n' + folders.join(',\n') + '\n]}\n';
}

/** Why this is not the club's map, or '' if it is: lanes (polygons) and hazards (points) present. */
function problems(map) {
  const all = map.folders.flatMap((f) => f.features);
  const out = [];
  if (!all.some((f) => f.type === 'polygon')) out.push('no lanes or areas (polygons)');
  if (!all.some((f) => f.type === 'point')) out.push('no hazards (points)');
  return out.join('; ');
}

function main(argv) {
  const [input, output] = argv;
  if (!input || !output) {
    console.error('Usage: node scripts/hazard_map.js <map.kml> <out.json>');
    return 2;
  }
  let map;
  try {
    map = kmlToMap(fs.readFileSync(input, 'utf8'));
  } catch (e) {
    console.error(`Not converted: ${e.message}. ${output} is unchanged.`);
    return 1;
  }
  const why = problems(map);
  if (why) {
    console.error(`Not the club's map (${why}). ${output} is unchanged.`);
    return 1;
  }
  const json = toJson(map);
  const tmp = `${output}.tmp`;
  fs.writeFileSync(tmp, json);
  fs.renameSync(tmp, output);
  const n = map.folders.reduce((a, f) => a + f.features.length, 0);
  console.log(`${output}: ${n} features in ${map.folders.length} folders (${map.folders.map((f) => f.name).join(', ')}).`);
  return 0;
}

module.exports = { parseXml, decodeEntities, kmlColor, coordinates, plainText, kmlToMap, toJson, problems, main, MAP_ID };

if (require.main === module) process.exitCode = main(process.argv.slice(2));
