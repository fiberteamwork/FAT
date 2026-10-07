// Customer parser web worker
// Listens for messages: { cmd: 'parse', text: string, wardIndexEntries: Array<[key, coord]>, options: { chunkSize }}

function normalize(value){
    return String(value ?? "").replace(/^\uFEFF/, '').replace(/\u00A0/g,' ').trim().replace(/\s+/g,' ');
}
function normalizeKey(value){
    return normalize(String(value ?? '')).toLowerCase().replace(/[^a-z0-9\s]+/g, '').replace(/\s+/g, ' ').trim();
}
function sanitizeNumberString(s){
    let str = String(s ?? '').replace(/,/g, '.');
    if (!str) return NaN;
    str = str.replace(/[^0-9.\-]/g, '');
    const parts = str.split('.'); if (parts.length > 2) str = parts.shift() + '.' + parts.join('');
    if (str === '' || str === '.' || str === '-') return NaN;
    return parseFloat(str);
}

function parseCSV(text){
    text = text.replace(/^\uFEFF/, '');
    const lines = text.split(/\r?\n/).filter(l => l.trim() !== '');
    if (lines.length === 0) return [];
    const headers = lines[0].split(';').map(h => String(h).replace(/^\uFEFF/, '').trim().replace(/\s+/g,' '));
    const result = [];
    for (let i = 1; i < lines.length; i++){
        const cols = lines[i].split(';');
        const row = {};
        headers.forEach((header, idx) => { row[header] = (cols[idx] ?? '').trim(); });
        result.push(row);
    }
    return result;
}

function maybeLonLat(coord){
    if (!Array.isArray(coord) || coord.length < 2) return null;
    const x = Number(coord[0]); const y = Number(coord[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    if (Math.abs(x) <= 180 && Math.abs(y) <= 90) return { longitude: x, latitude: y };
    return null; // worker doesn't handle projection transforms
}

// Build csvWardCoordinateIndex from raw rows
function buildCsvWardCoordinateIndex(rawRows, defaultLatKey, defaultLonKey){
    const map = new Map();
    for (const row of rawRows){
        const city = normalize(row['City'] || '');
        const district = normalize(row['District'] || '');
        const ward = normalize(row['Ward'] || '');
        const keys = Object.keys(row);
        const latKey = (defaultLatKey && Object.prototype.hasOwnProperty.call(row, defaultLatKey)) ? defaultLatKey : (keys.find(k => /lat/i.test(k)) || 'Latitude');
        const lonKey = (defaultLonKey && Object.prototype.hasOwnProperty.call(row, defaultLonKey)) ? defaultLonKey : (keys.find(k => /lon|lng|long|longitude|x/i.test(k)) || 'Longitude');
        let rawLat = sanitizeNumberString(row[latKey] ?? row['Latitude'] ?? '');
        let rawLon = sanitizeNumberString(row[lonKey] ?? row['Longitude'] ?? '');
        if (Number.isFinite(rawLat) && Number.isFinite(rawLon)){
            if (Math.abs(rawLat) > 90 && Math.abs(rawLon) <= 90) [rawLat, rawLon] = [rawLon, rawLat];
            else if ((rawLat >= 111 && rawLat <= 115) && (rawLon <= -6 && rawLon >= -8)) [rawLat, rawLon] = [rawLon, rawLat];
        }
        let lat = rawLat; let lon = rawLon;
        if (Number.isFinite(lat) && Math.abs(lat) > 90) lat /= 1000000;
        if (Number.isFinite(lon) && Math.abs(lon) > 180) lon /= 1000000;
        if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) < 1e-6 || Math.abs(lon) < 1e-6) continue;
        const coord = { latitude: lat, longitude: lon };
        const keysToAdd = new Set();
        const cityVariants = [city, normalize(city.replace(/^kab(\.|upaten)?\s+/i, ''))].filter(Boolean);
        const districtVariants = [district, normalize(district.replace(/^kab(\.|upaten)?\s+/i, ''))].filter(Boolean);
        const wardVariants = [ward].filter(Boolean);
        function addKey(c, d, w){ keysToAdd.add(`${normalizeKey(c||'')}||${normalizeKey(d||'')}||${normalizeKey(w||'')}`); }
        for (const cv of cityVariants){ for (const dv of districtVariants){ for (const wv of wardVariants){ addKey(cv,dv,wv); addKey(cv,dv,''); } addKey(cv,'',''); } }
        for (const k of keysToAdd) if (!map.has(k)) map.set(k, coord);
    }
    return map;
}

function buildWardIndexMap(entries){
    const map = new Map();
    if (!Array.isArray(entries)) return map;
    for (const e of entries){
        try { map.set(String(e[0]), e[1]); } catch (e) {}
    }
    return map;
}

function getCoordinateFromMapIndex(map, city, district, ward){
    if (!map || map.size === 0) return null;
    const nc = normalize(city||''); const nd = normalize(district||''); const nw = normalize(ward||'');
    const candidates = [];
    candidates.push(`${normalizeKey(nc)}||${normalizeKey(nd)}||${normalizeKey(nw)}`);
    candidates.push(`${normalizeKey(nc)}||${normalizeKey(nd)}||`);
    candidates.push(`||${normalizeKey(nd)}||${normalizeKey(nw)}`);
    candidates.push(`||${normalizeKey(nd)}||`);
    candidates.push(`||${normalizeKey(nw)}`);
    for (const k of candidates){ if (map.has(k)) return Object.assign({matchedKey:k}, map.get(k)); }
    return null;
}

self.onmessage = function(e){
    const msg = e.data || {};
    if (msg.cmd === 'parse'){
        try{
            const text = msg.text || '';
            const wardIndexEntries = msg.wardIndexEntries || [];
            const options = msg.options || {};
            const raw = parseCSV(text);
            const headerKeys = Object.keys(raw[0] || {});
            const defaultLatKey = headerKeys.find(k => /lat/i.test(k)) || 'Latitude';
            const defaultLonKey = headerKeys.find(k => /lon|lng|long|longitude|x/i.test(k)) || 'Longitude';
            const csvIndex = buildCsvWardCoordinateIndex(raw, defaultLatKey, defaultLonKey);
            const wardMap = buildWardIndexMap(wardIndexEntries);

            const customers = [];
            for (let i=0;i<raw.length;i++){
                const row = raw[i];
                const keys = Object.keys(row);
                const latKey = (defaultLatKey && Object.prototype.hasOwnProperty.call(row, defaultLatKey)) ? defaultLatKey : (keys.find(k => /lat/i.test(k)) || 'Latitude');
                const lonKey = (defaultLonKey && Object.prototype.hasOwnProperty.call(row, defaultLonKey)) ? defaultLonKey : (keys.find(k => /lon|lng|long|longitude|x/i.test(k)) || 'Longitude');
                const id = normalize(row['ID Customer'] ?? row['lD Customer'] ?? row['Id Customer'] ?? row[keys[0]] ?? '');
                if (!id) continue;
                const username = normalize(row['Username']);
                const city = normalize(row['City']);
                const district = normalize(row['District']);
                const ward = normalize(row['Ward']);
                const team = normalize(row['Team']);
                const vendor = normalize(row['Vendor']||team);
                const site = normalize(row['Site Name'] ?? row['CEK SITE NAME SYSTEM'] ?? '');
                const status = normalize(row['Status Instalasi/Maintenence'] ?? row['Status Instalasi/Maintenance'] ?? '');
                const visitDate = normalize(row['Visit Date']);
                let rawLat = sanitizeNumberString(row[latKey] ?? row['Latitude'] ?? '');
                let rawLon = sanitizeNumberString(row[lonKey] ?? row['Longitude'] ?? '');
                let swapped = false;
                if (Number.isFinite(rawLat) && Number.isFinite(rawLon)){
                    if (Math.abs(rawLat) > 90 && Math.abs(rawLon) <= 90) { [rawLat, rawLon] = [rawLon, rawLat]; swapped = true; }
                    else if ((rawLat >= 111 && rawLat <= 115) && (rawLon <= -6 && rawLon >= -8)) { [rawLat, rawLon] = [rawLon, rawLat]; swapped = true; }
                }
                let lat = rawLat; let lon = rawLon;
                if (Number.isFinite(lat) && Math.abs(lat) > 90) lat /= 1000000;
                if (Number.isFinite(lon) && Math.abs(lon) > 180) lon /= 1000000;
                let resolvedBy = 'original';

                // Detect explicit zeros from original numeric parse
                const origZero = (Number.isFinite(rawLat) && Number.isFinite(rawLon) && rawLat === 0 && rawLon === 0);

                let invalidCoord = (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) < 1e-6 || Math.abs(lon) < 1e-6 || origZero);
                if (!invalidCoord){
                    // simple bounds not checked here
                }
                if (invalidCoord){
                    // If orig coords were explicit zeros, try ward index first
                    let resolved = false;
                    if (origZero) {
                        const w = getCoordinateFromMapIndex(wardMap, city, district, ward);
                        if (w) { lat = w.latitude; lon = w.longitude; resolvedBy='wardIndex'; resolved = true; }
                    }
                    if (!resolved) {
                        // try CSV-based index first
                        const cityCoord = csvIndex.get(`${normalizeKey(city)}||${normalizeKey(district)}||${normalizeKey(ward)}`) || csvIndex.get(`${normalizeKey(city)}||${normalizeKey(district)}||`) || csvIndex.get(`||${normalizeKey(district)}||${normalizeKey(ward)}`) || null;
                        if (cityCoord){ lat = cityCoord.latitude; lon = cityCoord.longitude; resolvedBy='csvWard'; resolved = true; }
                    }
                    if (!resolved) {
                        // try wardMap from main thread
                        const w = getCoordinateFromMapIndex(wardMap, city, district, ward);
                        if (w){ lat = w.latitude; lon = w.longitude; resolvedBy='wardIndex'; resolved = true; }
                    }
                    if (!resolved) { lat = -7.33; lon = 112.73; resolvedBy='default'; }
                }
                customers.push({ id, username, city, district, ward, site, team, vendor, status, visitDate, latitude: lat, longitude: lon, resolvedBy });
            }
            self.postMessage({ cmd: 'done', customers });
        } catch (err){
            self.postMessage({ cmd: 'error', message: String(err), stack: err && err.stack });
        }
    }
};
