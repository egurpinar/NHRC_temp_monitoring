#!/usr/bin/env node
/**
 * Tests for scripts/hazard_map.js: the club's Google map (KML) -> the
 * website's hazard-map.json.
 *
 * The real KML is in scripts/fixtures/hazard_map.kml (the Safety Committee's
 * "Lake Housatonic Navigation" map, as Google exported it in October 2026).
 *
 * Run: node scripts/test_hazard_map.js
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const H = require('./hazard_map');

const KML = fs.readFileSync(path.join(__dirname, 'fixtures', 'hazard_map.kml'), 'utf8');
const MAP_JSON = path.join(__dirname, '..', 'map', 'hazard-map.json');

let passed = 0, failed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (e) { failed++; failures.push([name, e]); console.log(`  FAIL  ${name}\n        ${e.message.split('\n').join('\n        ')}`); }
}
const quiet = (fn) => { const e = console.error, l = console.log; console.error = () => {}; console.log = () => {}; try { return fn(); } finally { console.error = e; console.log = l; } };

console.log('\nThe XML reader\n--------------');

test('elements, attributes, text, CDATA, comments and entities', () => {
  const t = H.parseXml('<?xml version="1.0"?><!-- a note --><a x="1" y=\'two &amp; three\'><b>caf&#233; &lt;ok&gt; &#x41;</b><c/>'
    + '<d><![CDATA[<h3>$[name]</h3> & more]]></d><kml:e>x</kml:e></a>');
  const a = t.children[0];
  assert.strictEqual(a.name, 'a');
  assert.deepStrictEqual(a.attrs, { x: '1', y: 'two & three' });
  assert.deepStrictEqual(a.children.map((c) => c.name), ['b', 'c', 'd', 'e'], 'a namespace prefix is dropped');
  assert.strictEqual(a.children[0].text, 'café <ok> A');
  assert.strictEqual(a.children[2].text, '<h3>$[name]</h3> & more', 'CDATA as it is');
});

test('a ">" inside a quoted attribute does not end the tag', () => {
  const t = H.parseXml('<a title="1 > 0">x</a>');
  assert.strictEqual(t.children[0].attrs.title, '1 > 0');
  assert.strictEqual(t.children[0].text, 'x');
});

test('broken XML is refused, never half-read', () => {
  for (const bad of ['<a><b></a>', '<a>', '<a><!-- x</a>', '<a><![CDATA[x</a>', '<a x="1>y</a>', '</a>']) {
    assert.throws(() => H.parseXml(bad), Error, bad);
  }
});

test('unknown or impossible entities are left as they are', () => {
  assert.strictEqual(H.decodeEntities('&nbsp; &#0; &#x110000; &amp;'), '&nbsp; &#0; &#x110000; &');
});

console.log('\nKML\n---');

test('KML colours are aabbggrr', () => {
  assert.deepStrictEqual(H.kmlColor('ff0051e6'), { color: '#E65100', opacity: 1 });
  assert.deepStrictEqual(H.kmlColor('4d589d0f'), { color: '#0F9D58', opacity: 0.3 });
  assert.deepStrictEqual(H.kmlColor('ff00d6ff'), { color: '#FFD600', opacity: 1 });
  assert.strictEqual(H.kmlColor('red'), null);
});

test('coordinates are lon,lat in KML and [lat, lon] out; anything else is refused', () => {
  assert.deepStrictEqual(H.coordinates(' -73.1559688,41.3762356,0\n  -73.1,41.3 '), [[41.3762356, -73.1559688], [41.3, -73.1]]);
  for (const bad of ['-73.1', 'a,b', '-73,95', '200,41']) assert.throws(() => H.coordinates(bad), /not a coordinate/, bad);
});

test('descriptions come out as plain text: line breaks kept, markup dropped', () => {
  assert.strictEqual(H.plainText('Line one<br>line two'), 'Line one\nline two');
  assert.strictEqual(H.plainText('<b>Bold</b> <img src=x onerror=alert(1)>text &amp; more'), 'Bold text & more');
  assert.strictEqual(H.plainText(''), '');
});

console.log('\nThe club\'s map\n--------------');

const MAP = H.kmlToMap(KML, { copied: '2026-10-18' });
const all = MAP.folders.flatMap((f) => f.features);

test('the three folders and all eighteen features of the Google map', () => {
  assert.strictEqual(MAP.name, 'Lake Housatonic Navigation');
  assert.deepStrictEqual(MAP.folders.map((f) => [f.name, f.features.length]), [['Downstream 1', 3], ['Upstream', 3], ['Hazards', 12]]);
  assert.deepStrictEqual(all.filter((f) => f.type === 'point').length, 9);
  assert.deepStrictEqual(all.filter((f) => f.type === 'polygon').length, 9, 'six lanes, two swim areas and the ski course');
});

test('the lanes keep the map\'s colours: downstream orange, upstream green, see-through as on Google', () => {
  for (const f of MAP.folders[0].features) {
    assert.deepStrictEqual([f.color, f.fillColor, f.fillOpacity, f.weight], ['#E65100', '#E65100', 0.3, 1.2], f.name);
  }
  assert.deepStrictEqual(MAP.folders[1].features.map((f) => [f.color, f.fillOpacity]), [['#0F9D58', 0.3], ['#0F9D58', 0.3], ['#0F9D58', 0.35]]);
});

test('the hazards: orange where it says do not row, yellow for caution - with the committee\'s words', () => {
  const byName = (n) => all.filter((f) => f.name === n);
  for (const n of ['Shallow Area', 'Sandbar and Exposed Pipe', 'Do not Row Beyond This Point!']) assert.strictEqual(byName(n)[0].color, '#E65100', n);
  for (const n of ['Boulder', 'Tree in the Water', 'Sandbar', 'Tree in the Water and Potential Shallow Shoreline']) {
    assert.ok(byName(n).every((f) => f.color === '#FFD600'), n);
  }
  assert.strictEqual(byName('Do not Row Beyond This Point!')[0].description, 'Do not pass the power lines as it will bring you very close to the dam.');
  assert.deepStrictEqual(byName('Do not Row Beyond This Point!')[0].coords, [41.3268702, -73.1054312]);
  assert.strictEqual(byName('Tree in the Water')[0].description, '', 'no description on Google: none here');
  assert.ok(all.every((f) => !/[<>]/.test(f.description)), 'no markup anywhere');
});

test('the swim areas and the ski course are yellow areas, with their notes', () => {
  for (const n of ['State Park Swim Area', 'Swim Area', 'Water Ski Course']) {
    const f = all.find((x) => x.name === n);
    assert.strictEqual(f.type, 'polygon');
    assert.strictEqual(f.color, '#FFD600');
    assert.ok(f.description.length > 20, n);
  }
});

test('every coordinate is on Lake Housatonic, between the shallows above the boathouse and the Derby dam', () => {
  for (const f of all) {
    const pts = f.type === 'point' ? [f.coords] : f.coords;
    for (const [lat, lon] of pts) assert.ok(lat > 41.32 && lat < 41.38 && lon > -73.16 && lon < -73.10, `${f.name}: ${lat},${lon}`);
  }
  for (const f of all.filter((x) => x.type === 'polygon')) {
    assert.deepStrictEqual(f.coords[0], f.coords[f.coords.length - 1], `${f.name}: a closed ring`);
  }
});

test('the dock the club gave sits where the upstream lanes meet', () => {
  const dock = [41.36854219880895, -73.14781279793873];
  const joint = MAP.folders[1].features[0].coords[0];           // Upstream Section 1 starts at Section 2's top
  const m = Math.hypot((dock[0] - joint[0]) * 111000, (dock[1] - joint[1]) * 83500);
  assert.ok(m < 10, `${m.toFixed(1)} m apart`);
});

console.log('\nThe JSON, and the command\n-------------------------');

test('the JSON reads back as the same map, one feature a line', () => {
  const json = H.toJson(MAP);
  assert.deepStrictEqual(JSON.parse(json), MAP);
  // The opening line, two per folder, one per feature, the closing line, and the final newline.
  assert.strictEqual(json.split('\n').length, 1 + 3 * 2 + 18 + 1 + 1, 'a line each, plus the folder lines');
  assert.ok(json.length < 20000, `small: ${json.length} bytes`);
});

test('the map\'s copy is exactly what this script makes from the KML', () => {
  const page = JSON.parse(fs.readFileSync(MAP_JSON, 'utf8'));
  assert.deepStrictEqual(page, H.kmlToMap(KML, { copied: page.copied }), 'regenerate it: node scripts/hazard_map.js scripts/fixtures/hazard_map.kml map/hazard-map.json');
  assert.ok(/^\d{4}-\d\d-\d\d$/.test(page.copied));
});

test('the command writes the JSON - and never replaces a good copy with an error page or a broken file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nhrc-map-'));
  const out = path.join(dir, 'map.json');
  fs.writeFileSync(path.join(dir, 'map.kml'), KML);
  assert.strictEqual(quiet(() => H.main([path.join(dir, 'map.kml'), out])), 0);
  const good = fs.readFileSync(out, 'utf8');
  assert.strictEqual(JSON.parse(good).folders.length, 3);
  const cases = {
    'google.html': '<!DOCTYPE html><html><body>Sorry, something went wrong</body></html>',
    'empty.kml': '<?xml version="1.0"?><kml><Document><name>x</name></Document></kml>',
    'points-only.kml': '<kml><Document><Placemark><name>p</name><Point><coordinates>-73.1,41.3</coordinates></Point></Placemark></Document></kml>',
    'cut.kml': KML.slice(0, KML.length / 2),
    'bad-coords.kml': KML.replace('-73.1559688,41.3762356,0', 'oops'),
  };
  for (const [name, text] of Object.entries(cases)) {
    fs.writeFileSync(path.join(dir, name), text);
    assert.strictEqual(quiet(() => H.main([path.join(dir, name), out])), 1, name);
    assert.strictEqual(fs.readFileSync(out, 'utf8'), good, `${name}: the good copy is untouched`);
  }
  assert.strictEqual(quiet(() => H.main([])), 2, 'usage');
  assert.deepStrictEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')), [], 'nothing half-written left behind');
});

test('loose placemarks, lines, and kinds the site does not draw', () => {
  const kml = `<kml><Document><name>Test</name>
    <Style id="s"><LineStyle><color>ff0000ff</color><width>3</width></LineStyle></Style>
    <Placemark><name>Loose</name><Point><coordinates>-73.12,41.35</coordinates></Point></Placemark>
    <Folder><name>F</name>
      <Placemark><name>Line</name><styleUrl>#s</styleUrl><LineString><coordinates>-73.12,41.35 -73.13,41.36</coordinates></LineString></Placemark>
      <Placemark><name>Model</name><Model/></Placemark>
      <Folder><name>Inner</name><Placemark><name>Area</name><Polygon><outerBoundaryIs><LinearRing><coordinates>
        -73.12,41.35 -73.13,41.35 -73.13,41.36 -73.12,41.35</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark></Folder>
    </Folder></Document></kml>`;
  const m = H.kmlToMap(kml, { copied: '2026-10-18' });
  assert.deepStrictEqual(m.folders.map((f) => [f.name, f.features.map((x) => x.name)]), [['Test', ['Loose']], ['F', ['Line', 'Area']]]);
  assert.deepStrictEqual([m.folders[1].features[0].color, m.folders[1].features[0].weight], ['#FF0000', 3]);
  assert.strictEqual(m.folders[1].features[1].fillOpacity, 0.3, 'no style: still visible');
});

console.log(`\n${'='.repeat(60)}\n${passed} passed, ${failed} failed\n${'='.repeat(60)}`);
if (failed) {
  for (const [n, e] of failures) console.log(`  - ${n}: ${e.message.split('\n')[0]}`);
  process.exitCode = 1;
}
