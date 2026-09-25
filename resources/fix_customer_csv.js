/*
Fix customer CSV coordinates by resolving invalid/missing coords (0;0 or non-numeric)
using ward/district/city polygons from layer JS files.

Usage: node resources\\fix_customer_csv.js

Writes: data/customer_fixed.csv (overwrites if exists)

Notes:
- This script attempts to safely evaluate the layer JS files to retrieve the feature
  collections defined as a top-level var in the files (e.g., "var lyr_surabaya_2 = {...};").
- It uses a simple centroid (average of first ring vertices) as the ward coordinate.
- Adjust paths below if your files are in different locations.
*/

const fs = require('fs');
const path = require('path');
const vm = require('vm');

// === CONFIG ===
const projectRoot = path.resolve(__dirname, '..');
const layerFiles = [
  path.join(projectRoot, 'layers', 'surabaya_2.js'),
  path.join(projectRoot, 'layers', 'SIDOARJO_1.js')
];
const inputCsv = path.join(projectRoot, 'data', 'customer.csv');
const outputCsv = path.join(projectRoot, 'data', 'customer_fixed.csv');

// candidate property names to find city/district/ward in layer feature properties
const CITY_KEYS = ['CITY','KAB','KOTA','KABUPATEN','PROVINSI','PROP','PROPINSI','ADM1_NAME'];
const DISTRICT_KEYS = ['DISTRICT','KECAMATAN','KEC','ADM2_NAME'];
const WARD_KEYS = ['WARD','KELURAHAN','DESA','GAM','NAMOBJ','NAME','NM_KEL','ADM3_NAME'];

function loadLayerJs(filePath){
  if(!fs.existsSync(filePath)){
    console.warn('Layer file not found:', filePath);
    return null;
  }
  const code = fs.readFileSync(filePath, 'utf8');
  const m = code.match(/var\s+([A-Za-z0-9_]+)\s*=/);
  if(!m){
    console.warn('Could not detect "var <name> =" in', filePath);
    return null;
  }
  const varName = m[1];
  // Wrap code in IIFE and return the variable value
  const wrapped = `(function(){\n${code}\nreturn ${varName};\n})()`;
  try{
    const obj = vm.runInNewContext(wrapped, {}, {timeout: 1000});
    if(!obj || !obj.features) {
      console.warn('Loaded layer has no features:', filePath);
      return null;
    }
    return obj;
  }catch(e){
    console.warn('Failed to evaluate layer file', filePath, e && e.message);
    return null;
  }
}

function computeCentroidSimple(feature){
  if(!feature || !feature.geometry) return null;
  const g = feature.geometry;
  let ring = null;
  if(g.type === 'Polygon'){
    ring = g.coordinates && g.coordinates[0];
  }else if(g.type === 'MultiPolygon'){
    if(Array.isArray(g.coordinates) && g.coordinates[0] && g.coordinates[0][0]) ring = g.coordinates[0][0];
  }
  if(!ring || !ring.length) return null;
  let sx=0, sy=0, n=0;
  for(const c of ring){
    if(!Array.isArray(c) || c.length < 2) continue;
    const x = Number(c[0]);
    const y = Number(c[1]);
    if(!isFinite(x) || !isFinite(y)) continue;
    sx += x; sy += y; n++;
  }
  if(n===0) return null;
  return [sx/n, sy/n]; // [lon, lat]
}

function pickProp(props, candidates){
  if(!props) return null;
  for(const key of candidates){
    if(Object.prototype.hasOwnProperty.call(props, key) && props[key] != null && props[key] !== '') return String(props[key]);
  }
  // try case-insensitive fallback
  const lowMap = {};
  for(const k of Object.keys(props)) lowMap[k.toLowerCase()] = props[k];
  for(const cand of candidates){
    const v = lowMap[cand.toLowerCase()];
    if(v!=null && v!=='') return String(v);
  }
  return null;
}

function normalizeName(s){
  if(!s) return '';
  let t = String(s).toUpperCase();
  // remove common prefixes
  t = t.replace(/^(KAB\.?|KABUPATEN\.?|KOTA\.?|PROVINSI\.?|PROP\.?)/i, '');
  t = t.replace(/[^A-Z0-9 ]+/g, ' ');
  t = t.replace(/\s+/g, ' ').trim();
  return t;
}

function buildWardIndex(layers){
  const map = new Map();
  let count = 0;
  for(const layer of layers){
    if(!layer) continue;
    for(const f of layer.features){
      const props = f.properties || {};
      const city = pickProp(props, CITY_KEYS) || '';
      const district = pickProp(props, DISTRICT_KEYS) || '';
      const ward = pickProp(props, WARD_KEYS) || '';
      const normCity = normalizeName(city);
      const normDistrict = normalizeName(district);
      const normWard = normalizeName(ward);
      const centroid = computeCentroidSimple(f);
      if(!centroid) continue;
      const key = `${normCity}||${normDistrict}||${normWard}`;
      map.set(key, {centroid, props});
      // also store fallback keys to increase match chance
      const key2 = `||${normDistrict}||${normWard}`;
      if(!map.has(key2)) map.set(key2, {centroid, props});
      const key3 = `||${normDistrict}||`;
      if(!map.has(key3)) map.set(key3, {centroid, props});
      count++;
    }
  }
  console.log('buildWardIndex: entries=', map.size, 'featuresIndexed=', count);
  return map;
}

function sanitizeNumberString(s){
  if(s == null) return NaN;
  let t = String(s).trim();
  if(t === '') return NaN;
  t = t.replace(/\s+/g, '');
  t = t.replace(/,/g, '.');
  // remove any non-digit/dot/minus
  t = t.replace(/[^0-9.\-]+/g, '');
  // collapse multiple dots
  const parts = t.split('.');
  if(parts.length > 2){
    // join all but first as decimals
    t = parts.shift() + '.' + parts.join('');
  }
  const v = parseFloat(t);
  if(!isFinite(v)) return NaN;
  // fix million-scale bad values
  if(Math.abs(v) > 90 && Math.abs(v) < 1000000) {
    // possibly lon/lat swapped or bad; leave for caller to interpret
  }
  return v;
}

function findHeaderIndex(headers, candidates){
  const low = headers.map(h => (h||'').toLowerCase());
  for(const cand of candidates){
    const ci = low.findIndex(h => h.includes(cand));
    if(ci>=0) return ci;
  }
  return -1;
}

// === Main ===
(function main(){
  console.log('Starting fix_customer_csv.js');
  // load layers
  const layers = [];
  for(const lf of layerFiles){
    const layer = loadLayerJs(lf);
    if(layer) layers.push(layer);
  }
  if(layers.length===0){
    console.warn('No layers loaded; index will be empty. Aborting.');
    return;
  }
  const wardIndex = buildWardIndex(layers);

  if(!fs.existsSync(inputCsv)){
    console.error('Input CSV not found:', inputCsv);
    return;
  }
  const raw = fs.readFileSync(inputCsv, 'utf8');
  const lines = raw.split(/\r?\n/);
  if(lines.length === 0){
    console.error('CSV empty');
    return;
  }
  const headerLine = lines[0];
  const headers = headerLine.split(';').map(h=>h.trim());

  // find lat/lon indices
  const latIdx = findHeaderIndex(headers, ['latitude','lat','y']);
  const lonIdx = findHeaderIndex(headers, ['longitude','lon','lng','x']);
  if(latIdx < 0 || lonIdx < 0){
    console.error('Could not find latitude/longitude columns in header. Found headers:', headers);
    return;
  }
  // find ward/district/city indices for resolution
  const wardIdx = findHeaderIndex(headers, ['kelurahan','kel','desa','ward','village','nm_kel','nama_kel']);
  const districtIdx = findHeaderIndex(headers, ['kecamatan','kec','district']);
  const cityIdx = findHeaderIndex(headers, ['kota','kab','kabupaten','city']);

  const outLines = [headerLine];
  let total = 0, changed = 0, resolved = 0, defaulted = 0, failures = 0;
  const samples = [];
  for(let i=1;i<lines.length;i++){
    const line = lines[i];
    if(!line || line.trim()==='') continue;
    total++;
    const cols = line.split(';');
    const rawLat = cols[latIdx] ? cols[latIdx].trim() : '';
    const rawLon = cols[lonIdx] ? cols[lonIdx].trim() : '';
    let lat = sanitizeNumberString(rawLat);
    let lon = sanitizeNumberString(rawLon);
    let changedThis = false;
    if(!isFinite(lat) || !isFinite(lon) || (lat===0 && lon===0)){
      // attempt to resolve using ward/district/city
      const wardVal = wardIdx>=0 ? (cols[wardIdx]||'') : '';
      const districtVal = districtIdx>=0 ? (cols[districtIdx]||'') : '';
      const cityVal = cityIdx>=0 ? (cols[cityIdx]||'') : '';
      const keyVariants = [];
      const nCity = normalizeName(cityVal);
      const nDistrict = normalizeName(districtVal);
      const nWard = normalizeName(wardVal);
      keyVariants.push(`${nCity}||${nDistrict}||${nWard}`);
      keyVariants.push(`||${nDistrict}||${nWard}`);
      keyVariants.push(`||${nDistrict}||`);
      let matched = null;
      for(const k of keyVariants){
        if(wardIndex.has(k)) { matched = wardIndex.get(k); break; }
      }
      if(!matched){
        // fallback: try substring match over keys
        for(const [k,v] of wardIndex.entries()){
          if(nWard && k.includes(nWard)) { matched = v; break; }
        }
      }
      if(matched){
        lon = Number(matched.centroid[0]);
        lat = Number(matched.centroid[1]);
        resolved++;
        changedThis = true;
        if(samples.length < 50) samples.push({line:i+1,origLat:rawLat,origLon:rawLon,resLat:lat,resLon:lon,matchedProps: matched.props});
      }else{
        // fallback: keep as-is or set to empty; here we set to blank so it's obvious
        // Optionally set to a default coordinate; currently we leave as original but count failure
        failures++;
      }
    }
    if(changedThis){
      // replace columns
      cols[latIdx] = String(lat);
      cols[lonIdx] = String(lon);
      changed++;
    }
    outLines.push(cols.join(';'));
  }

  try{
    fs.writeFileSync(outputCsv, outLines.join('\r\n'), 'utf8');
    console.log('Wrote fixed CSV to', outputCsv);
  }catch(e){
    console.error('Failed to write output CSV', e && e.message);
    return;
  }

  console.log('Summary:', {total, changed, resolved, failures});
  if(samples.length) {
    console.log('Samples of resolved rows (up to 50):');
    console.dir(samples, {depth:2});
  }
  console.log('Done.');
})();
