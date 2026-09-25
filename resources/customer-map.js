/* =========================================================
   CUSTOMER MAP
   CSV : ./data/customer.csv
   Separator : ;
   ========================================================= */

console.log('[CUSTOMER_MAP] loaded version 20260924.1 (FAT XLSX)');

const DATA_URL = "./data/Data FAT Full.xlsx";
// Debug: when true, markers are rendered as large bright red circles to aid visibility while debugging
// Toggle to true to force-visible markers
const DEBUG_HIGHLIGHT_MARKERS = false;

let customers = [];
let customerLayer = null;
let customerSource = null;
let customerExpandedLayer = null;
let customerExpandedSource = null;
let wardChart = null;
let customerDrawVersion = 0;
let customerDrawTimeout = null;

// Device geolocation layer & state
let userLocationLayer = null;
let userLocationFeature = null;
let userLocationAccuracyFeature = null;


// Remove stale customer layers or layers that accidentally contain customer features
function removeStaleCustomerLayers() {
    try {
        if (typeof map === 'undefined' || !map || typeof map.getLayers !== 'function') return;
        const stack = map.getLayers().getArray().slice();
        while (stack.length) {
            const layer = stack.shift();
            try {
                if (!layer) continue;
                // If layer is a group, enqueue its children
                if (typeof layer.getLayers === 'function') {
                    const childLayers = layer.getLayers().getArray() || [];
                    for (const cl of childLayers) stack.push(cl);
                }
                const isCustomerLayer = (layer.get && (layer.get('customerLayer') === true || layer.get('title') === 'Customer'));
                if (isCustomerLayer) {
                    map.removeLayer(layer);
                    console.log('removeStaleCustomerLayers: removed explicit customer layer');
                    continue;
                }
                // check source features for 'customer' property
                const src = layer.getSource && layer.getSource();
                if (src && typeof src.getFeatures === 'function') {
                    const feats = src.getFeatures() || [];
                    if (feats.some(f => f && typeof f.get === 'function' && (f.get('customer') !== undefined || f.get('groupMembers') !== undefined))) {
                        map.removeLayer(layer);
                        console.log('removeStaleCustomerLayers: removed layer containing customer features');
                    }
                }
            } catch (e) {
                // ignore per-layer errors
            }
        }
    } catch (e) {
        console.warn('removeStaleCustomerLayers failed', e);
    }
}


/* =========================================================
   STATUS COLORS
   ========================================================= */

const STATUS_CONFIG = {

    "fat": {
        label: "🔴 FAT",
        color: "#ef4444"
    },

    "nonfat": {
        label: "🔵 Non FAT",
        color: "#3b82f6"
    },

    "default": {
        label: "⚪ Lainnya",
        color: "#6b7280"
    }

};

const PORT_STATUS_CONFIG = {
    full: { label: "Full", color: "#ef4444" },
    available: { label: "Available", color: "#3b82f6" },
    partial: { label: "Partial", color: "#f59e0b" },
    unknown: { label: "Tidak diketahui", color: "#6b7280" }
};

const PORT_STATUS_FILTER_KEYS = ["full", "available"];

function getPortStatusKey(customer) {
    const explicit = String(
        customer?.dataFatFull?.["Status Port"] ??
        customer?.statusPort ??
        customer?.status ??
        ""
    ).trim().toLowerCase();

    if (explicit.includes("full") || explicit.includes("penuh")) return "full";
    if (explicit.includes("avaible") || explicit.includes("available") || explicit.includes("idle")) return "available";

    const used = Number(customer?.totalUsedVisual);
    const idle = Number(customer?.totalIdleVisual);
    if (Number.isFinite(used) && Number.isFinite(idle)) {
        if (used > 0 && idle <= 0) return "full";
        if (used <= 0 && idle > 0) return "available";
        if (used > 0 && idle > 0) return "partial";
    }
    return "unknown";
}

function getPortStatusColor(customer) {
    return PORT_STATUS_CONFIG[getPortStatusKey(customer)].color;
}


/* =========================================================
ORMALIZE TEXT
   ========================================================= */

// Memoized normalize to avoid repeated expensive regex ops on repeated strings
const __normalize_cache = new Map();
function normalize(value){
    const s = String(value ?? "");
    if (__normalize_cache.has(s)) return __normalize_cache.get(s);
    const out = s
        .replace(/^\uFEFF/,'')
        .replace(/\u00A0/g,' ')
        .trim()
        .replace(/\s+/g,' ');
    __normalize_cache.set(s, out);
    return out;
}

// Memoized normalizeKey
const __normalizeKey_cache = new Map();
function normalizeKey(value){
    const s = String(value ?? '');
    if (__normalizeKey_cache.has(s)) return __normalizeKey_cache.get(s);
    const out = normalize(s)
        .toLowerCase()
        .replace(/[^a-z0-9\s]+/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    __normalizeKey_cache.set(s, out);
    return out;
}

function maybeLonLat(coord){
    if (!Array.isArray(coord) || coord.length < 2) return null;
    const x = Number(coord[0]);
    const y = Number(coord[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    // If coordinate is already in lon/lat range, return it directly.
    if (Math.abs(x) <= 180 && Math.abs(y) <= 90) {
        return { longitude: x, latitude: y };
    }
    // Otherwise assume the input is in WebMercator and transform to lon/lat.
    try {
        const lonlat = ol.proj.toLonLat([x, y]);
        return { longitude: lonlat[0], latitude: lonlat[1] };
    } catch (e) {
        return null;
    }
}

function getFeatureInteriorCoordinate(feature){
    try {
        const geom = feature && feature.getGeometry && feature.getGeometry();
        if (!geom) return null;

        if (typeof geom.getInteriorPoint === 'function') {
            const interior = geom.getInteriorPoint();
            if (interior && typeof interior.getCoordinates === 'function') {
                const coords = interior.getCoordinates();
                const maybe = maybeLonLat(coords);
                if (maybe) return { latitude: maybe.latitude, longitude: maybe.longitude };
            }
        }

        const center = ol.extent.getCenter(geom.getExtent());
        const maybe = maybeLonLat(center);
        if (maybe) return { latitude: maybe.latitude, longitude: maybe.longitude };
    } catch (e) {
        // ignore geometry errors
    }
    return null;
}

// Fast sanitizeNumberString with small memo cache
const __sanitize_cache = new Map();
function sanitizeNumberString(s){
    const key = String(s ?? '');
    if (__sanitize_cache.has(key)) return __sanitize_cache.get(key);
    let str = key.replace(/,/g, '.');
    // keep only digits, dot and minus
    // quick path for empty or common values
    if (!str) { __sanitize_cache.set(key, NaN); return NaN; }
    // remove any character except digits, dot and minus
    str = str.replace(/[^0-9.\-]/g, '');
    const parts = str.split('.');
    if (parts.length > 2) str = parts.shift() + '.' + parts.join('');
    if (str === '' || str === '.' || str === '-') { __sanitize_cache.set(key, NaN); return NaN; }
    const num = parseFloat(str);
    __sanitize_cache.set(key, num);
    return num;
}

function isWithinIndonesiaBounds(lat, lon){
    return Number.isFinite(lat) && Number.isFinite(lon) &&
        lat >= -12.0 && lat <= 6.0 &&
        lon >= 95.0 && lon <= 141.0;
}

// Parse visit date strings (expects dd/mm/yyyy or d/m/yyyy, but tolerates other separators)
function parseVisitDate(s) {
    if (!s) return null;
    const str = String(s).trim();
    // Try dd/mm/yyyy or d/m/yyyy
    const m1 = str.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})$/);
    if (m1) {
        const day = m1[1].padStart(2,'0');
        const month = m1[2].padStart(2,'0');
        const year = m1[3];
        return { day, month, year };
    }
    // Try yyyy-mm-dd
    const m2 = str.match(/^(\d{4})[\-](\d{1,2})[\-](\d{1,2})$/);
    if (m2) {
        const year = m2[1];
        const month = m2[2].padStart(2,'0');
        const day = m2[3].padStart(2,'0');
        return { day, month, year };
    }
    return null;
}

const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];


/* =========================================================
   STATUS KEY
   ========================================================= */

function getStatusKey(status) {

    const s = normalize(status).toLowerCase();

    if (!s || s === "-")
        return "default";

    if (s.includes("non fat") || s.includes("nonfat") || s.includes("non-fat"))
        return "nonfat";

    if (s.includes("fat"))
        return "fat";

    return "default";
}


/* =========================================================
   STATUS COLOR
   ========================================================= */

function getStatusColor(status) {

    return STATUS_CONFIG[
        getStatusKey(status)
    ].color;

}


/* =========================================================
   CSV PARSER
   ========================================================= */

function parseCSV(text) {

    // Hilangkan BOM
    text = text.replace(/^\uFEFF/, "");

    const lines = text
        .split(/\r?\n/)
        .filter(line => line.trim() !== "");

    if (lines.length === 0) return [];

    // Header
    const headers = lines[0]
        .split(";")
        .map(h =>
            String(h)
                .replace(/^\uFEFF/, "")
                .trim()
                .replace(/\s+/g, " ")
        );

    // Perbaiki kemungkinan "lD Customer"
    headers[0] = headers[0]
        .replace(/^lD Customer$/i, "ID Customer")
        .replace(/^Id Customer$/i, "ID Customer");

    const result = [];

    for (let i = 1; i < lines.length; i++) {

        const cols = lines[i].split(";");

        const row = {};

        headers.forEach((header, index) => {
            row[header] = (cols[index] ?? "").trim();
        });

        result.push(row);
    }

    return result;
}

// ==============================
// ALIAS HEADER DATA FAT FULL
// ==============================
const FAT_HEADER_ALIASES = {
    id:        ["id customer", "idcustomer", "id_cust", "id", "no", "nomor", "customer id", "cust id"],
    label:     ["label", "nama", "nama customer", "nama pelanggan", "customer", "customer name", "name", "pelanggan"],
    city:      ["kota/kabupaten", "kota/kab", "kota kabupaten", "kota-kabupaten", "kota", "kabupaten", "kab/kota", "kab kota", "city", "kab", "kabkota"],
    district:  ["kecamatan", "kec", "district"],
    ward:      ["kelurahan", "desa", "kel", "ward", "village"],
    site:      ["nama site", "namasite", "site", "site name", "nama sisi", "sisi", "lokasi site"],
    status:    ["status", "keterangan fat", "jenis", "jenis fat", "kategori", "tipe", "fat/non fat"],
    ket:       ["keterangan", "ket", "catatan", "note", "notes", "remark"],
    visitDate: ["tanggal", "tgl", "tanggal visit", "tgl visit", "visit date", "tanggal fat", "tgl fat", "date"],
    latitude:  ["latitude", "lat", "koordinat latitude", "lintang", "y", "user latitude"],
    longitude: ["longitude", "lon", "long", "lng", "koordinat longitude", "bujur", "x", "user longitude"],
    splitterCount: ["jumlah splitter", "jumlah splitters", "splitter count", "splitter", "total splitter"],
    totalPort: ["total port", "total ports", "jumlah port", "port total", "port"],
    totalUsedVisual: ["total used (visual)", "total used visual", "used visual", "used", "total used"],
    totalIdleVisual: ["total idle (visual)", "total idle visual", "idle visual", "idle", "total idle"]
};

// Resolve pemetaan header -> field internal, sekali per dataset (dengan cache per set header)
const __fatHeaderCache = new Map();
function resolveFATHeaders(rawRows) {
    if (!Array.isArray(rawRows) || rawRows.length === 0) return {};
    const headers = Object.keys(rawRows[0] || {});
    const cacheKey = headers.join('\u0001');
    if (__fatHeaderCache.has(cacheKey)) return __fatHeaderCache.get(cacheKey);

    const normHeader = h => String(h || '').replace(/^\uFEFF/, '').replace(/\s+/g, ' ').trim().toLowerCase().replace(/[.:]$/, '');
    const compact = s => String(s || '').toLowerCase().replace(/[^a-z0-9/]+/g, '');

    const mapping = {};
    for (const field of Object.keys(FAT_HEADER_ALIASES)) {
        mapping[field] = null;
    }

    const used = new Set();
    // Pass 1: exact (dinormalisasi) match, urutan field penting (city sebelum lat/lon dsb.)
    const fieldOrder = ['id', 'label', 'city', 'district', 'ward', 'site', 'status', 'ket', 'visitDate', 'latitude', 'longitude', 'splitterCount', 'totalPort', 'totalUsedVisual', 'totalIdleVisual'];
    for (const field of fieldOrder) {
        const aliases = FAT_HEADER_ALIASES[field];
        let found = null;
        for (const alias of aliases) {
            for (const h of headers) {
                if (used.has(h)) continue;
                if (normHeader(h) === alias) { found = h; break; }
            }
            if (found) break;
            // compact match untuk kota/kabupaten vs kota-kabupaten dsb.
            for (const h of headers) {
                if (used.has(h)) continue;
                if (compact(h) === compact(alias)) { found = h; break; }
            }
            if (found) break;
        }
        if (found) { mapping[field] = found; used.add(found); }
    }
    // Pass 2: fallback includes() untuk field yang belum ketemu
    for (const field of fieldOrder) {
        if (mapping[field]) continue;
        const aliases = FAT_HEADER_ALIASES[field];
        for (const alias of aliases) {
            for (const h of headers) {
                if (used.has(h)) continue;
                if (normHeader(h).includes(alias) || alias.includes(normHeader(h))) {
                    // hindari salah kunci: header pendek jangan menelan alias panjang
                    if (normHeader(h).length < 3) continue;
                    mapping[field] = h; used.add(h); break;
                }
            }
            if (mapping[field]) break;
        }
    }

    __fatHeaderCache.set(cacheKey, mapping);
    console.log('[CUSTOMER_MAP] resolveFATHeaders:', JSON.stringify(mapping));
    return mapping;
}

// Konversi satu baris object (dari XLSX/CSV) ke struktur customer internal
function parseFATRow(row, mapping, index) {
    const get = (field) => {
        const key = mapping[field];
        return key ? normalize(row[key] ?? '') : '';
    };

    let lat = sanitizeNumberString(mapping.latitude ? (row[mapping.latitude] ?? '') : '');
    let lon = sanitizeNumberString(mapping.longitude ? (row[mapping.longitude] ?? '') : '');
    // deteksi lat/lon tertukar (khas data Indonesia)
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
        if (Math.abs(lat) > 90 && Math.abs(lon) <= 90) { const t = lat; lat = lon; lon = t; }
        else if ((lat >= 111 && lat <= 115) && (lon <= -6 && lon >= -8)) { const t = lat; lat = lon; lon = t; }
    }
    if (Number.isFinite(lat) && Math.abs(lat) > 90) lat /= 1000000;
    if (Number.isFinite(lon) && Math.abs(lon) > 180) lon /= 1000000;

    const splitterCount = sanitizeNumberString(mapping.splitterCount ? (row[mapping.splitterCount] ?? '') : '');
    const totalPort = sanitizeNumberString(mapping.totalPort ? (row[mapping.totalPort] ?? '') : '');
    const totalUsedVisual = sanitizeNumberString(mapping.totalUsedVisual ? (row[mapping.totalUsedVisual] ?? '') : '');
    const totalIdleVisual = sanitizeNumberString(mapping.totalIdleVisual ? (row[mapping.totalIdleVisual] ?? '') : '');

    let city = get('city');
    const district = get('district');
    const ward = get('ward');
    const site = get('site');
    const status = get('status');
    const ket = get('ket');
    const visitDate = get('visitDate');
    let label = get('label');
    let id = get('id');

    // Validasi koordinat; resolve via polygon ward bila tidak valid
    const hasDecimals = (String(lat).split('.')[1] || '').length >= 2 && (String(lon).split('.')[1] || '').length >= 2;
    let invalidCoord = (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) < 1e-6 || Math.abs(lon) < 1e-6 || !hasDecimals);
    if (!invalidCoord && !isWithinIndonesiaBounds(lat, lon)) invalidCoord = true;

    let resolvedBy = 'original';
    if (invalidCoord) {
        let coord = getCoordinateFromCsvWard(city, district, ward) || getCoordinateFromWard(city, district, ward);
        if (coord) {
            resolvedBy = 'wardIndex';
            lat = coord.latitude; lon = coord.longitude;
        } else {
            const cityFallback = getCoordinateFromCity(city);
            if (cityFallback) { lat = cityFallback.latitude; lon = cityFallback.longitude; resolvedBy = 'cityFallback'; }
            else { lat = -7.33; lon = 112.73; resolvedBy = 'default'; }
        }
    }

    return {
        id: id || label || ('ROW' + (index + 1)),
        label,
        username: label,
        city,
        district,
        ward,
        site,
        team: '',
        vendor: '',
        status,
        ket,
        visitDate,
        latitude: lat,
        longitude: lon,
        splitterCount: Number.isFinite(splitterCount) ? splitterCount : undefined,
        totalPort: Number.isFinite(totalPort) ? totalPort : undefined,
        totalUsedVisual: Number.isFinite(totalUsedVisual) ? totalUsedVisual : undefined,
        totalIdleVisual: Number.isFinite(totalIdleVisual) ? totalIdleVisual : undefined,
        dataFatFull: Object.assign({}, row),
        resolvedBy
    };
}

function fallbackParseCustomerRows(raw) {
    const customers = [];
    if (!Array.isArray(raw) || raw.length === 0) return customers;
    // Coba parser FAT terlebih dahulu (mapping header adaptif)
    const mapping = resolveFATHeaders(raw);
    if (mapping && (mapping.label || mapping.site || mapping.city)) {
        raw.forEach((row, index) => {
            customers.push(parseFATRow(row, mapping, index));
        });
        if (customers.length > 0) return customers;
    }

    raw.forEach((row, index) => {
        const keys = Object.keys(row);
        const id = normalize(row["ID Customer"] ?? row["lD Customer"] ?? row["Id Customer"] ?? row[keys[0]] ?? "");
        if (!id) {
            if (index < 5) console.warn('[CUSTOMER_MAP] fallbackParseCustomerRows missing id on row', index, row);
            return;
        }
        const username = normalize(row["Username"]);
        const city = normalize(row["City"]);
        const district = normalize(row["District"]);
        const ward = normalize(row["Ward"]);
        const team = normalize(row["Team"]);
        const vendor = normalize(row["Vendor"] || team);
        const site = normalize(row["Site Name"] ?? row["CEK SITE NAME SYSTEM"] ?? "");
        const status = normalize(row["Status Instalasi/Maintenence"] ?? row["Status Instalasi/Maintenance"] ?? "");
        const visitDate = normalize(row["Visit Date"]);
        const latKey = keys.find(k => /lat/i.test(k)) || "Latitude";
        const lonKey = keys.find(k => /lon|lng|long|longitude|x/i.test(k)) || "Longitude";
        let rawLat = sanitizeNumberString(row[latKey] ?? row["Latitude"] ?? "");
        let rawLon = sanitizeNumberString(row[lonKey] ?? row["Longitude"] ?? "");
        let swapped = false;
        if (Number.isFinite(rawLat) && Number.isFinite(rawLon)){
            if (Math.abs(rawLat) > 90 && Math.abs(rawLon) <= 90) {
                const t = rawLat; rawLat = rawLon; rawLon = t; swapped = true;
            } else if ((rawLat >= 111 && rawLat <= 115) && (rawLon <= -6 && rawLon >= -8)) {
                const t = rawLat; rawLat = rawLon; rawLon = t; swapped = true;
            }
        }
        let lat = rawLat;
        let lon = rawLon;
        if (Number.isFinite(lat) && Math.abs(lat) > 90) lat /= 1000000;
        if (Number.isFinite(lon) && Math.abs(lon) > 180) lon /= 1000000;
        if (swapped) {
            // diagnostic swap fallback
        }
        if (!isWithinIndonesiaBounds(lat, lon) || !Number.isFinite(lat) || !Number.isFinite(lon)) {
            const coord = getCoordinateFromWard(city, district, ward);
            if (coord) {
                lat = coord.latitude;
                lon = coord.longitude;
            }
        }
        customers.push({
            id,
            username,
            city,
            district,
            ward,
            site,
            team,
            vendor,
            status,
            visitDate,
            latitude: lat,
            longitude: lon
        });
    });
    return customers;
}

function getCoordinateFromWard_old(city, district, ward) {

    const layers = [
        lyr_surabaya_2,
        lyr_SIDOARJO_1
    ];

    city = normalize(city);
    district = normalize(district);
    ward = normalize(ward);

    for (const layer of layers) {

        const features =
            layer.getSource().getFeatures();

        for (const feature of features) {

            const fCity = normalize(feature.get("CITY"));

            const fDistrict = normalize(feature.get("KECAMATAN"));

            const fWard = normalize(feature.get("DESA"));

            if (
                fCity === city &&
                fDistrict === district &&
                fWard === ward
            ) {

                const center =
                    ol.extent.getCenter(
                        feature
                            .getGeometry()
                            .getExtent()
                    );

                const lonlat =
                    ol.proj.toLonLat(center);

                return {

                    latitude: lonlat[1],
                    longitude: lonlat[0]

                };

            }

        }

    }

    return null;

}

let wardIndex = new Map();
let wardFallbackCache = new Map();
let csvWardCoordinateIndex = new Map();

/* =========================================================
   WARD POLYGON INDEX (for random point generation)
   ========================================================= */
let wardPolygonIndex = new Map(); // key: normalized city||district||ward → array of polygon coordinate rings

function getPolygonCoordinateRings(geometry) {
    if (!geometry) return [];
    const rings = [];
    if (geometry.type === 'Polygon' && Array.isArray(geometry.coordinates)) {
        for (const ring of geometry.coordinates) {
            if (Array.isArray(ring) && ring.length >= 3) rings.push(ring);
        }
    } else if (geometry.type === 'MultiPolygon' && Array.isArray(geometry.coordinates)) {
        for (const poly of geometry.coordinates) {
            if (Array.isArray(poly)) {
                for (const ring of poly) {
                    if (Array.isArray(ring) && ring.length >= 3) rings.push(ring);
                }
            }
        }
    }
    return rings;
}

function getOLGeometryRings(geom) {
    if (!geom) return [];
    try {
        if (typeof geom.getCoordinates === 'function') {
            const coords = geom.getCoordinates();
            const rings = [];
            // OpenLayers Polygon: coords = [exteriorRing, ...holes]
            // OpenLayers MultiPolygon: coords = [ [exteriorRing, ...holes], ... ]
            const type = geom.getType && geom.getType();
            if (type === 'Polygon' && Array.isArray(coords) && coords.length >= 1) {
                for (const ring of coords) {
                    if (Array.isArray(ring) && ring.length >= 3) {
                        // transform from EPSG:3857 to EPSG:4326
                        const lonlatRing = ring.map(c => {
                            try { const ll = ol.proj.toLonLat(c); return ll; } catch(e) { return c; }
                        });
                        rings.push(lonlatRing);
                    }
                }
            } else if (type === 'MultiPolygon' && Array.isArray(coords)) {
                for (const poly of coords) {
                    if (Array.isArray(poly)) {
                        for (const ring of poly) {
                            if (Array.isArray(ring) && ring.length >= 3) {
                                const lonlatRing = ring.map(c => {
                                    try { const ll = ol.proj.toLonLat(c); return ll; } catch(e) { return c; }
                                });
                                rings.push(lonlatRing);
                            }
                        }
                    }
                }
            }
            return rings;
        }
    } catch(e) {}
    return [];
}

// Ray-casting algorithm for point-in-polygon test
function pointInPolygonLonLat(lon, lat, polygonRing) {
    if (!Array.isArray(polygonRing) || polygonRing.length < 3) return false;
    let inside = false;
    const n = polygonRing.length;
    for (let i = 0, j = n - 1; i < n; j = i++) {
        const xi = polygonRing[i][0], yi = polygonRing[i][1];
        const xj = polygonRing[j][0], yj = polygonRing[j][1];
        if (((yi > lat) !== (yj > lat)) && (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi)) {
            inside = !inside;
        }
    }
    return inside;
}

function pointInAnyPolygon(lon, lat, rings) {
    if (!Array.isArray(rings) || rings.length === 0) return false;
    // First ring is exterior, must be inside
    if (!pointInPolygonLonLat(lon, lat, rings[0])) return false;
    // Check holes (subsequent rings) — must NOT be inside any hole
    for (let h = 1; h < rings.length; h++) {
        if (pointInPolygonLonLat(lon, lat, rings[h])) return false;
    }
    return true;
}

// Check if a point (lon, lat) is inside any polygon in wardPolygonIndex
function isPointInAnyWardPolygon(lon, lat) {
    if (!wardPolygonIndex || wardPolygonIndex.size === 0) return false;
    for (const [, rings] of wardPolygonIndex.entries()) {
        if (pointInAnyPolygon(lon, lat, rings)) return true;
    }
    return false;
}

// Generate a random point within a polygon using rejection sampling on bounding box
function getRandomPointInPolygonRings(rings, maxAttempts) {
    if (!Array.isArray(rings) || rings.length === 0) return null;
    const exterior = rings[0];
    if (!exterior || exterior.length < 3) return null;

    // Compute bounding box of exterior ring
    let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
    for (const c of exterior) {
        if (c[0] < minLon) minLon = c[0];
        if (c[0] > maxLon) maxLon = c[0];
        if (c[1] < minLat) minLat = c[1];
        if (c[1] > maxLat) maxLat = c[1];
    }

    const attempts = maxAttempts || 500;
    for (let i = 0; i < attempts; i++) {
        const lon = minLon + Math.random() * (maxLon - minLon);
        const lat = minLat + Math.random() * (maxLat - minLat);
        if (pointInAnyPolygon(lon, lat, rings)) {
            return { longitude: lon, latitude: lat };
        }
    }
    // Fallback: return centroid with small random jitter to avoid exact overlap
    let sx = 0, sy = 0;
    for (const c of exterior) { sx += c[0]; sy += c[1]; }
    const jitterLon = (Math.random() - 0.5) * (maxLon - minLon) * 0.05;
    const jitterLat = (Math.random() - 0.5) * (maxLat - minLat) * 0.05;
    return { longitude: sx / exterior.length + jitterLon, latitude: sy / exterior.length + jitterLat };
}

// Build wardPolygonIndex from OpenLayers polygon layers
function buildWardPolygonIndex() {
    wardPolygonIndex.clear();
    try {
        const layers = [];
        if (typeof lyr_surabaya_2 !== 'undefined' && lyr_surabaya_2) layers.push(lyr_surabaya_2);
        if (typeof lyr_SIDOARJO_1 !== 'undefined' && lyr_SIDOARJO_1) layers.push(lyr_SIDOARJO_1);
        if (typeof lyr_Denpasar_1 !== 'undefined' && lyr_Denpasar_1) layers.push(lyr_Denpasar_1);

        for (const layer of layers) {
            try {
                const features = layer.getSource().getFeatures() || [];
                for (const feature of features) {
                    const rawCity = normalize(getFeatureValue(feature, ['CITY','city','City','CITYNAME']));
                    const rawDistrict = normalize(getFeatureValue(feature, ['KECAMATAN','kecamatan','district','District','DistrictName']));
                    const rawWard = normalize(getFeatureValue(feature, ['DESA','desa','Ward','WARD','NAMOBJ','name']));
                    if (!rawWard && !rawDistrict && !rawCity) continue;

                    const geom = feature.getGeometry && feature.getGeometry();
                    const rings = getOLGeometryRings(geom);
                    if (rings.length === 0) continue;

                    // Store under multiple key variants for matching (same as getCoordinateFromWard)
                    const storeKey = (c, d, w) => {
                        const key = normalizeLocationKey(c, d, w);
                        if (key && !wardPolygonIndex.has(key)) wardPolygonIndex.set(key, rings);
                    };

                    const strippedCity = normalize(stripAdminPrefixes(rawCity));
                    const strippedDistrict = normalize(stripAdminPrefixes(rawDistrict));
                    const wardShort = normalize(shortWardName(rawWard));

                    const wardNoSpace = normalize((rawWard || '').replace(/\s+/g, ''));

                    storeKey(rawCity, rawDistrict, rawWard);
                    storeKey(strippedCity, rawDistrict, rawWard);
                    storeKey(rawCity, strippedDistrict, rawWard);
                    storeKey(strippedCity, strippedDistrict, rawWard);
                    storeKey(rawCity, rawDistrict, wardShort);
                    storeKey(strippedCity, strippedDistrict, wardShort);
                    // Space-stripped variants (e.g. 'SIWALAN PANJI' → 'siwalanpanji')
                    storeKey(rawCity, rawDistrict, wardNoSpace);
                    storeKey(strippedCity, strippedDistrict, wardNoSpace);
                    storeKey('', rawDistrict, wardNoSpace);
                    // Cityless variants (for matching when city is empty or missing)
                    storeKey('', rawDistrict, rawWard);
                    storeKey('', strippedDistrict, rawWard);
                    storeKey('', rawDistrict, wardShort);
                    storeKey('', strippedDistrict, wardShort);
                }
            } catch(e) { /* skip layer */ }
        }
        console.log('[CUSTOMER_MAP] buildWardPolygonIndex entries=', wardPolygonIndex.size);
        // Log all BUDURAN ward keys for debugging
        const buduranKeys = [];
        for (const [k] of wardPolygonIndex.entries()) {
            if (k.includes('buduran')) buduranKeys.push(k);
        }
        console.log('[WARD_IDX] BUDURAN polygon keys:', buduranKeys.join(' | '));
    } catch(e) { console.warn('buildWardPolygonIndex error', e); }
}

// Get random point inside ward polygon boundaries
function getRandomPointInWard(city, district, ward) {
    if (wardPolygonIndex.size === 0) buildWardPolygonIndex();

    const nc = normalize(city || '');
    const nd = normalize(district || '');
    const nw = normalize(ward || '');
    const strippedNd = normalize(stripAdminPrefixes(district || ''));
    const nwShort = normalize(shortWardName(ward || ''));

    const nwNoSpace = normalize((ward || '').replace(/\s+/g, ''));

    // Try multiple key variants (same as getCoordinateFromWard)
    const candidates = [
        normalizeLocationKey(nc, nd, nw),
        normalizeLocationKey(nc, strippedNd, nw),
        normalizeLocationKey(nc, nd, nwShort),
        normalizeLocationKey(nc, strippedNd, nwShort),
        // Space-stripped ward name (e.g. 'SIWALAN PANJI' → 'siwalanpanji')
        normalizeLocationKey(nc, nd, nwNoSpace),
        normalizeLocationKey(nc, strippedNd, nwNoSpace),
        // Cityless variants (for matching when city is empty or missing)
        normalizeLocationKey('', nd, nw),
        normalizeLocationKey('', strippedNd, nw),
        normalizeLocationKey('', nd, nwShort),
        normalizeLocationKey('', strippedNd, nwShort),
        normalizeLocationKey('', nd, nwNoSpace),
        normalizeLocationKey('', strippedNd, nwNoSpace),
        // District-only variants
        normalizeLocationKey('', nd, ''),
        normalizeLocationKey('', strippedNd, ''),
    ].filter(Boolean);

    for (const key of candidates) {
        if (wardPolygonIndex.has(key)) {
            return getRandomPointInPolygonRings(wardPolygonIndex.get(key));
        }
    }

    // Fuzzy fallback: try partial ward name match within same district
    const targetWard = normalizeKey(nw);
    const targetDistrict = normalizeKey(nd);
    console.log('[WARD_LOOKUP] ward=' + ward + ' district=' + district + ' NO EXACT MATCH. Candidates tried:', candidates.slice(0, 5).join(', '));
    for (const [key, rings] of wardPolygonIndex.entries()) {
        try {
            const parts = key.split('||').map(p => normalizeKey(p || ''));
            const kCity = parts[0] || '';
            const kDistrict = parts[1] || '';
            const kWard = parts[2] || '';
            const wardMatch = targetWard && kWard && (kWard.includes(targetWard) || targetWard.includes(kWard));
            const districtMatch = !targetDistrict || (kDistrict && (kDistrict.includes(targetDistrict) || targetDistrict.includes(kDistrict)));
            if (wardMatch && districtMatch) {
                return getRandomPointInPolygonRings(rings);
            }
        } catch(e) {}
    }

    // Final fallback: pick any random polygon from the same district
    if (targetDistrict) {
        const sameDistrict = [];
        for (const [key, rings] of wardPolygonIndex.entries()) {
            try {
                const parts = key.split('||').map(p => normalizeKey(p || ''));
                const kDistrict = parts[1] || '';
                if (kDistrict && (kDistrict.includes(targetDistrict) || targetDistrict.includes(kDistrict))) {
                    sameDistrict.push(rings);
                }
            } catch(e) {}
        }
        if (sameDistrict.length > 0) {
            const pick = sameDistrict[Math.floor(Math.random() * sameDistrict.length)];
            return getRandomPointInPolygonRings(pick);
        }
    }

    return null;
}

function compactKey(value) {
    return normalizeKey(value)
        .replace(/\s+/g, '');
}

function normalizeLocationKey(city, district, ward) {
    return [city, district, ward]
        .map(value => normalizeKey(value || ""))
        .join("||");
}

function normalizeLocationKeyCompact(city, district, ward) {
    return [city, district, ward]
        .map(value => String(normalize(value || "")).toLowerCase().replace(/[^a-z0-9]+/g, ''))
        .join("||");
}

function buildCsvWardCoordinateIndex(rawRows) {
    csvWardCoordinateIndex.clear();

    if (!Array.isArray(rawRows) || rawRows.length === 0)
        return;

    // detect header keys once for performance
    const headerKeys = Object.keys(rawRows[0] || {});
    const defaultLatKey = headerKeys.find(k => /lat/i.test(k)) || "Latitude";
    const defaultLonKey = headerKeys.find(k => /lon|lng|long|longitude|x/i.test(k)) || "Longitude";

    rawRows.forEach(row => {
        const city = normalize(row["City"] || "");
        const district = normalize(row["District"] || "");
        const ward = normalize(row["Ward"] || "");
        const strippedCity = normalize(stripAdminPrefixes(city));
        const strippedDistrict = normalize(stripAdminPrefixes(district));
        const wardShort = normalize(shortWardName(ward));

        const keys = Object.keys(row);
        const latKey = (defaultLatKey && Object.prototype.hasOwnProperty.call(row, defaultLatKey)) ? defaultLatKey : (keys.find(k => /lat/i.test(k)) || "Latitude");
        const lonKey = (defaultLonKey && Object.prototype.hasOwnProperty.call(row, defaultLonKey)) ? defaultLonKey : (keys.find(k => /lon|lng|long|longitude|x/i.test(k)) || "Longitude");

        let rawLat = sanitizeNumberString(row[latKey] ?? row["Latitude"] ?? "");
        let rawLon = sanitizeNumberString(row[lonKey] ?? row["Longitude"] ?? "");

        if (Number.isFinite(rawLat) && Number.isFinite(rawLon)) {
            if (Math.abs(rawLat) > 90 && Math.abs(rawLon) <= 90) {
                [rawLat, rawLon] = [rawLon, rawLat];
            } else if ((rawLat >= 111 && rawLat <= 115) && (rawLon <= -6 && rawLon >= -8)) {
                [rawLat, rawLon] = [rawLon, rawLat];
            }
        }

        let lat = rawLat;
        let lon = rawLon;
        if (Number.isFinite(lat) && Math.abs(lat) > 90) lat /= 1000000;
        if (Number.isFinite(lon) && Math.abs(lon) > 180) lon /= 1000000;

        if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) < 1e-6 || Math.abs(lon) < 1e-6)
            return;

        const coord = { latitude: lat, longitude: lon };
        const wardVariants = [ward, normalize(stripAdminPrefixes(ward)), wardShort, ...splitWardVariants(ward)].filter(Boolean);
        const uniqueWardVariants = [...new Set(wardVariants)];
        const cityVariants = [city, strippedCity].filter(Boolean);
        const districtVariants = [district, strippedDistrict].filter(Boolean);

        const addKey = (cityValue, districtValue, wardValue) => {
            const key = normalizeLocationKey(cityValue, districtValue, wardValue);
            if (!csvWardCoordinateIndex.has(key)) {
                csvWardCoordinateIndex.set(key, coord);
            }
        };

        const addKeyCompact = (cityValue, districtValue, wardValue) => {
            const key = normalizeLocationKeyCompact(cityValue, districtValue, wardValue);
            if (!csvWardCoordinateIndex.has(key)) {
                csvWardCoordinateIndex.set(key, coord);
            }
        };

        const addAllKeys = (cityValue, districtValue, wardValue) => {
            addKey(cityValue, districtValue, wardValue);
            addKeyCompact(cityValue, districtValue, wardValue);
        };

        if (uniqueWardVariants.length === 0) {
            cityVariants.forEach(cityVariant => {
                if (districtVariants.length > 0) {
                    districtVariants.forEach(districtVariant => {
                        addAllKeys(cityVariant, districtVariant, "");
                        addAllKeys(cityVariant, "", "");
                        addAllKeys("", districtVariant, "");
                    });
                } else {
                    addAllKeys(cityVariant, "", "");
                }
            });
            districtVariants.forEach(districtVariant => addAllKeys("", districtVariant, ""));
            addAllKeys("", "", "");
            return;
        }

        uniqueWardVariants.forEach(wardVariant => {
            cityVariants.forEach(cityVariant => {
                if (districtVariants.length > 0) {
                    districtVariants.forEach(districtVariant => {
                        addAllKeys(cityVariant, districtVariant, wardVariant);
                        addAllKeys(cityVariant, districtVariant, "");
                        addAllKeys(cityVariant, "", wardVariant);
                        addAllKeys("", districtVariant, wardVariant);
                    });
                } else {
                    addAllKeys(cityVariant, "", wardVariant);
                    addAllKeys(cityVariant, "", "");
                }
            });
            if (districtVariants.length > 0) {
                districtVariants.forEach(districtVariant => {
                    addAllKeys("", districtVariant, wardVariant);
                    addAllKeys("", districtVariant, "");
                });
            }
            addAllKeys("", "", wardVariant);
            addAllKeys("", "", "");
        });
    });
}

function getCoordinateFromCsvWard(city, district, ward) {
    if (csvWardCoordinateIndex.size === 0)
        return null;

    const normalizedCity = normalize(city || "");
    const normalizedDistrict = normalize(district || "");
    const strippedCity = normalize(stripAdminPrefixes(normalizedCity));
    const strippedDistrict = normalize(stripAdminPrefixes(normalizedDistrict));
    const cityVariants = [normalizedCity, strippedCity].filter(Boolean);
    const districtVariants = [normalizedDistrict, strippedDistrict].filter(Boolean);

    const wardVariants = [
        normalize(ward),
        normalize(stripAdminPrefixes(ward)),
        normalize(shortWardName(ward)),
        ...splitWardVariants(ward)
    ].filter(Boolean);

    const candidateKeys = new Set();

    if (wardVariants.length === 0) {
        cityVariants.forEach(cityVariant => {
            if (districtVariants.length > 0) {
                districtVariants.forEach(districtVariant => {
                    candidateKeys.add(normalizeLocationKey(cityVariant, districtVariant, ""));
                    candidateKeys.add(normalizeLocationKeyCompact(cityVariant, districtVariant, ""));
                    candidateKeys.add(normalizeLocationKey(cityVariant, "", ""));
                    candidateKeys.add(normalizeLocationKeyCompact(cityVariant, "", ""));
                    candidateKeys.add(normalizeLocationKey("", districtVariant, ""));
                    candidateKeys.add(normalizeLocationKeyCompact("", districtVariant, ""));
                });
            } else {
                candidateKeys.add(normalizeLocationKey(cityVariant, "", ""));
                candidateKeys.add(normalizeLocationKeyCompact(cityVariant, "", ""));
            }
        });

        districtVariants.forEach(districtVariant => {
            candidateKeys.add(normalizeLocationKey("", districtVariant, ""));
            candidateKeys.add(normalizeLocationKeyCompact("", districtVariant, ""));
        });
    }

    wardVariants.forEach(wardVariant => {
        if (cityVariants.length > 0) {
            cityVariants.forEach(cityVariant => {
                if (districtVariants.length > 0) {
                    districtVariants.forEach(districtVariant => {
                        candidateKeys.add(normalizeLocationKey(cityVariant, districtVariant, wardVariant));
                        candidateKeys.add(normalizeLocationKeyCompact(cityVariant, districtVariant, wardVariant));
                        candidateKeys.add(normalizeLocationKey(cityVariant, districtVariant, ""));
                        candidateKeys.add(normalizeLocationKeyCompact(cityVariant, districtVariant, ""));
                        candidateKeys.add(normalizeLocationKey(cityVariant, "", wardVariant));
                        candidateKeys.add(normalizeLocationKeyCompact(cityVariant, "", wardVariant));
                        candidateKeys.add(normalizeLocationKey("", districtVariant, wardVariant));
                        candidateKeys.add(normalizeLocationKeyCompact("", districtVariant, wardVariant));
                    });
                } else {
                    candidateKeys.add(normalizeLocationKey(cityVariant, "", wardVariant));
                    candidateKeys.add(normalizeLocationKeyCompact(cityVariant, "", wardVariant));
                    candidateKeys.add(normalizeLocationKey(cityVariant, "", ""));
                    candidateKeys.add(normalizeLocationKeyCompact(cityVariant, "", ""));
                }
            });
        }

        if (cityVariants.length === 0 && districtVariants.length > 0) {
            districtVariants.forEach(districtVariant => {
                candidateKeys.add(normalizeLocationKey("", districtVariant, wardVariant));
                candidateKeys.add(normalizeLocationKeyCompact("", districtVariant, wardVariant));
                candidateKeys.add(normalizeLocationKey("", districtVariant, ""));
                candidateKeys.add(normalizeLocationKeyCompact("", districtVariant, ""));
            });
        }

        candidateKeys.add(normalizeLocationKey("", "", wardVariant));
        candidateKeys.add(normalizeLocationKeyCompact("", "", wardVariant));
    });

    for (const key of candidateKeys) {
        if (csvWardCoordinateIndex.has(key))
            return csvWardCoordinateIndex.get(key);
    }

    // Loose fallback using partial ward/district matches to recover misspellings or alternate naming conventions.
    const targetWard = normalizeKey(ward);
    const targetDistrict = normalizeKey(district);
    const targetCity = normalizeKey(city);

    if (targetWard || targetDistrict || targetCity) {
        for (const [key, coord] of csvWardCoordinateIndex.entries()) {
            const [cityKey, distKey, wardKey] = key.split('||').map(part => normalizeKey(part || ''));
            const wardMatch = targetWard && wardKey && (wardKey.includes(targetWard) || targetWard.includes(wardKey));
            const districtMatch = !targetDistrict || (distKey && (distKey.includes(targetDistrict) || targetDistrict.includes(distKey)));
            const cityMatch = !targetCity || (cityKey && (cityKey.includes(targetCity) || targetCity.includes(cityKey)));
            if ((wardMatch || (!targetWard && distKey && districtMatch)) && districtMatch && cityMatch) {
                return coord;
            }
        }
    }

    return null;
}

function getCoordinateFromCity(city) {
    const normalizedCity = normalize(city).toLowerCase();
    const cityFallbacks = {
        "kota surabaya": { latitude: -7.257472, longitude: 112.752088 },
        "surabaya": { latitude: -7.257472, longitude: 112.752088 },
        "kab. sidoarjo": { latitude: -7.4485, longitude: 112.7152 },
        "sidoarjo": { latitude: -7.4485, longitude: 112.7152 },
        "kota denpasar": { latitude: -8.6500, longitude: 115.2167 },
        "denpasar": { latitude: -8.6500, longitude: 115.2167 }
    };
    return cityFallbacks[normalizedCity] || null;
}

function stripAdminPrefixes(s){
    return s.replace(/^kab(\.|upaten)?\s+/i, '')
            .replace(/^kota\s+/i, '')
            .replace(/^kabupaten\s+/i, '')
            .replace(/^provinsi\s+/i, '')
            .replace(/["'\.]/g, '')
            .replace(/\s+/g, ' ')
            .trim();
}

function shortWardName(s){
    // remove RW/RT suffixes, common local prefixes, and content in parentheses
    return s.replace(/^\s*(desa|kelurahan)\s+/i, '')
            .replace(/\bRW\b.*$/i, '')
            .replace(/\bRT\b.*$/i, '')
            .replace(/\(.*\)/g, '')
            .replace(/[\.,]+/g, '.')
            .replace(/\s+/g, ' ')
            .trim();
}

function splitWardVariants(raw){
    const s = String(raw || '').trim();
    if (!s) return [];
    const parts = s.split(/[|\/]+/).map(p => normalize(p)).filter(Boolean);
    return [...new Set(parts)];
}

function getFeatureValue(feature, keys){
    const normalizedLookup = new Set(
        keys
            .map(key => normalize(String(key)).toLowerCase())
            .filter(Boolean)
    );

    if (typeof feature.getKeys === 'function') {
        const keysList = feature.getKeys();
        for (const key of keysList) {
            if (!normalizedLookup.has(normalize(String(key)).toLowerCase()))
                continue;
            const value = feature.get(key);
            if (value !== undefined && value !== null && String(value).trim() !== '') {
                return String(value);
            }
        }
    }

    for (const key of keys) {
        const value = feature.get(key);
        if (value !== undefined && value !== null && String(value).trim() !== '') {
            return String(value);
        }
    }

    return '';
}

function addWardKey(key, coord){
    const normalizedKey = normalizeKey(key);
    if (!wardIndex.has(normalizedKey)) wardIndex.set(normalizedKey, coord);
    const normalizedCompact = compactKey(key);
    if (normalizedCompact && !wardIndex.has(normalizedCompact)) wardIndex.set(normalizedCompact, coord);
}
function buildWardIndex(){

    try{
        wardIndex.clear();
        wardFallbackCache.clear();
        const layerPairs = [
            {layerVar: (typeof lyr_surabaya_2 !== 'undefined' ? lyr_surabaya_2 : null), jsonVarName: 'json_surabaya_2'},
                {layerVar: (typeof lyr_SIDOARJO_1 !== 'undefined' ? lyr_SIDOARJO_1 : null), jsonVarName: 'json_SIDOARJO_1'},
                {layerVar: (typeof lyr_Denpasar_1 !== 'undefined' ? lyr_Denpasar_1 : null), jsonVarName: 'json_Denpasar_1'
}
        ];

        layerPairs.forEach(pair => {
            const layer = pair.layerVar;

            // If we have an OpenLayers layer object, use its features
            if (layer && layer.getSource && typeof layer.getSource().getFeatures === 'function') {
                const features = layer.getSource().getFeatures() || [];
                features.forEach(feature => {
                    const rawCity = normalize(getFeatureValue(feature, ['CITY','city','City','CITYNAME']));
                    const rawDistrict = normalize(getFeatureValue(feature, ['KECAMATAN','kecamatan','district','District','DistrictName']));
                    const rawWard = normalize(getFeatureValue(feature, ['DESA','desa','Ward','WARD','NAMOBJ','name']));
                    const strippedCity = normalize(stripAdminPrefixes(rawCity));
                    const strippedDistrict = normalize(stripAdminPrefixes(rawDistrict));
                    const wardShort = normalize(shortWardName(rawWard));
                    try {
                        const coord = getFeatureInteriorCoordinate(feature) || (() => {
                            const center = ol.extent.getCenter(feature.getGeometry().getExtent());
                            const lonlat = ol.proj.toLonLat(center);
                            return { latitude: lonlat[1], longitude: lonlat[0] };
                        })();
                        const wardNoSpace = normalize((rawWard || '').replace(/\s+/g, ''));
                        addWardKey(`${rawCity}||${rawDistrict}||${rawWard}`, coord);
                        addWardKey(`${strippedCity}||${rawDistrict}||${rawWard}`, coord);
                        addWardKey(`${rawCity}||${strippedDistrict}||${rawWard}`, coord);
                        addWardKey(`${strippedCity}||${strippedDistrict}||${rawWard}`, coord);
                        addWardKey(`${rawCity}||${rawDistrict}||${wardShort}`, coord);
                        addWardKey(`${strippedCity}||${strippedDistrict}||${wardShort}`, coord);
                        addWardKey(`${rawCity}||${rawDistrict}||${wardNoSpace}`, coord);
                        addWardKey(`${strippedCity}||${strippedDistrict}||${wardNoSpace}`, coord);
                        addWardKey(`${rawCity}||${rawDistrict}||`, coord);
                        addWardKey(`${strippedCity}||${rawDistrict}||`, coord);
                        addWardKey(`${rawCity}||${strippedDistrict}||`, coord);
                        addWardKey(`${strippedCity}||${strippedDistrict}||`, coord);
                        addWardKey(`${rawCity}|||`, coord);
                        addWardKey(`${strippedCity}|||`, coord);
                        addWardKey(`||${rawDistrict}||`, coord);
                        addWardKey(`||${strippedDistrict}||`, coord);
                        addWardKey(`||${rawDistrict}||${rawWard}`, coord);
                        addWardKey(`||${rawDistrict}||${wardShort}`, coord);
                        addWardKey(`||${strippedDistrict}||${wardShort}`, coord);
                        addWardKey(`||${rawDistrict}||${wardNoSpace}`, coord);
                        addWardKey(`||${strippedDistrict}||${wardNoSpace}`, coord);
                        addWardKey(`||${rawWard}`, coord);
                        addWardKey(`||${wardShort}`, coord);
                    } catch (e) { /* ignore per-feature errors */ }
                });
                return; // continue to next pair
            }

            // Otherwise try to read the JSON variable embedded in the page
            try {
                const jsonVar = (typeof window !== 'undefined' ? window[pair.jsonVarName] : undefined) || (typeof globalThis !== 'undefined' ? globalThis[pair.jsonVarName] : undefined);
                if (jsonVar && Array.isArray(jsonVar.features)) {
                    jsonVar.features.forEach(f => {
                        const props = f.properties || {};
                        const rawCity = normalize(String(props.CITY || props.city || ''));
                        const rawDistrict = normalize(String(props.KECAMATAN || props.kecamatan || props.DISTRICT || props.district || ''));
                        const rawWard = normalize(String(props.DESA || props.desa || props.WARD || props.Ward || props.NAMOBJ || props.name || ''));
                        const strippedCity = normalize(stripAdminPrefixes(rawCity));
                        const strippedDistrict = normalize(stripAdminPrefixes(rawDistrict));
                        const wardShort = normalize(shortWardName(rawWard));
                        try {
                            let coords = null;
                            if (f.geometry && f.geometry.type === 'Polygon' && Array.isArray(f.geometry.coordinates) && f.geometry.coordinates[0]) coords = f.geometry.coordinates[0];
                            else if (f.geometry && f.geometry.type === 'MultiPolygon' && Array.isArray(f.geometry.coordinates) && f.geometry.coordinates[0] && f.geometry.coordinates[0][0]) coords = f.geometry.coordinates[0][0];
                            if (coords && coords.length) {
                                let sx = 0, sy = 0, n = 0;
                                for (const c of coords) {
                                    if (!Array.isArray(c) || c.length < 2) continue;
                                    const x = Number(c[0]), y = Number(c[1]);
                                    if (!isFinite(x) || !isFinite(y)) continue;
                                    sx += x; sy += y; n++;
                                }
                                if (n > 0) {
                                    let average = [sx / n, sy / n];
                                    const maybe = maybeLonLat(average);
                                    if (maybe) {
                                        const coord = { latitude: maybe.latitude, longitude: maybe.longitude };
                                        addWardKey(`${rawCity}||${rawDistrict}||${rawWard}`, coord);
                                        addWardKey(`${strippedCity}||${rawDistrict}||${rawWard}`, coord);
                                        addWardKey(`${rawCity}||${strippedDistrict}||${rawWard}`, coord);
                                        addWardKey(`${strippedCity}||${strippedDistrict}||${rawWard}`, coord);
                                        addWardKey(`${rawCity}||${rawDistrict}||${wardShort}`, coord);
                                        addWardKey(`${strippedCity}||${strippedDistrict}||${wardShort}`, coord);
                                        addWardKey(`${rawCity}||${rawDistrict}||`, coord);
                                        addWardKey(`${strippedCity}||${rawDistrict}||`, coord);
                                        addWardKey(`${rawCity}||${strippedDistrict}||`, coord);
                                        addWardKey(`${strippedCity}||${strippedDistrict}||`, coord);
                                        addWardKey(`${rawCity}|||`, coord);
                                        addWardKey(`${strippedCity}|||`, coord);
                                        addWardKey(`||${rawDistrict}||`, coord);
                                        addWardKey(`||${strippedDistrict}||`, coord);
                                        addWardKey(`||${rawDistrict}||${rawWard}`, coord);
                                        addWardKey(`||${rawDistrict}||${wardShort}`, coord);
                                        addWardKey(`||${strippedDistrict}||${wardShort}`, coord);
                                        addWardKey(`||${rawWard}`, coord);
                                        addWardKey(`||${wardShort}`, coord);
                                    }
                                }
                            }
                        } catch (e) { /* ignore */ }
                    });
                    return;
                }
            } catch (e) { /* ignore */ }

        });

    } catch (e) {
        console.error('buildWardIndex error', e);
    }

}

function getCoordinateFromWard(city, district, ward){
    if (wardIndex.size === 0) buildWardIndex();
    const nc_raw = String(city || '');
    const nd_raw = String(district || '');
    const nw_raw = String(ward || '');
    const nc = normalize(nc_raw);
    const nd = normalize(nd_raw);
    const nw = normalize(nw_raw);
    const nw_stripped = normalize(stripAdminPrefixes(nw_raw));
    const nw_short = normalize(shortWardName(nw_raw));
    const cacheKey = `${nc}||${nd}||${nw}`;

    if (wardFallbackCache.has(cacheKey)) {
        return wardFallbackCache.get(cacheKey);
    }

    const addCandidate = (arr, item) => {
        if (!item) return;
        const normalized = normalizeKey(item);
        if (normalized && !arr.includes(normalized)) arr.push(normalized);
    };

    const nw_noSpace = normalize((nw_raw || '').replace(/\s+/g, ''));
    const possibleWardParts = [nw, nw_stripped, nw_short, nw_noSpace, ...splitWardVariants(nw_raw)];
    const wardVariants = [...new Set(possibleWardParts.filter(Boolean))];

    const candidates = [];
    for (const wardVariant of wardVariants) {
        addCandidate(candidates, `${nc}||${nd}||${wardVariant}`);
        addCandidate(candidates, `${stripAdminPrefixes(nc)}||${nd}||${wardVariant}`);
        addCandidate(candidates, `${nc}||${stripAdminPrefixes(nd)}||${wardVariant}`);
        addCandidate(candidates, `${stripAdminPrefixes(nc)}||${stripAdminPrefixes(nd)}||${wardVariant}`);
        addCandidate(candidates, `${nc}||${nd}||${normalize(stripAdminPrefixes(wardVariant))}`);
        addCandidate(candidates, `${nc}||${nd}||${normalize(shortWardName(wardVariant))}`);
        addCandidate(candidates, `${nc}||${nd}||`);
        addCandidate(candidates, `${stripAdminPrefixes(nc)}||${nd}||`);
        addCandidate(candidates, `${nc}||${stripAdminPrefixes(nd)}||`);
        addCandidate(candidates, `${stripAdminPrefixes(nc)}||${stripAdminPrefixes(nd)}||`);
        addCandidate(candidates, `${nc}|||`);
        addCandidate(candidates, `${stripAdminPrefixes(nc)}|||`);
        addCandidate(candidates, `||${stripAdminPrefixes(nd)}||${wardVariant}`);
        addCandidate(candidates, `||${stripAdminPrefixes(nd)}||${normalize(stripAdminPrefixes(wardVariant))}`);
        addCandidate(candidates, `||${stripAdminPrefixes(nd)}||${normalize(shortWardName(wardVariant))}`);
        addCandidate(candidates, `||${nd}||${wardVariant}`);
        addCandidate(candidates, `||${nd}||`);
        addCandidate(candidates, `||${wardVariant}`);
        addCandidate(candidates, `||${normalize(shortWardName(wardVariant))}`);
    }

    if (wardVariants.length === 0) {
        addCandidate(candidates, `${nc}||${nd}||`);
        addCandidate(candidates, `${stripAdminPrefixes(nc)}||${nd}||`);
        addCandidate(candidates, `${nc}||${stripAdminPrefixes(nd)}||`);
        addCandidate(candidates, `${stripAdminPrefixes(nc)}||${stripAdminPrefixes(nd)}||`);
        addCandidate(candidates, `${nc}|||`);
        addCandidate(candidates, `${stripAdminPrefixes(nc)}|||`);
        addCandidate(candidates, `||${nd}||`);
        addCandidate(candidates, `||${stripAdminPrefixes(nd)}||`);
    }

    for (const k of candidates) {
        if (wardIndex.has(k)) {
            const c = Object.assign({matchedKey: k}, wardIndex.get(k));
            wardFallbackCache.set(cacheKey, c);
            return c;
        }
    }

    // If exact ward lookup fails, try compact no-space variants
    for (const k of candidates) {
        const compact = k.replace(/\s+/g, '');
        if (wardIndex.has(compact)) {
            const c = Object.assign({matchedKey: compact}, wardIndex.get(compact));
            wardFallbackCache.set(cacheKey, c);
            return c;
        }
    }

    const alnum = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g,'');
    const targetWard = alnum(nw);
    const targetDistrict = alnum(nd);
    const targetCity = alnum(nc);

    if (targetWard || targetDistrict || targetCity) {
        for (const [k, v] of wardIndex.entries()) {
            try {
                const parts = k.split('||');
                const kCity = alnum(parts[0] || '');
                const kDistrict = alnum(parts[1] || '');
                const kWard = alnum(parts[2] || '');

                const wardMatch = targetWard && kWard && (kWard.includes(targetWard) || targetWard.includes(kWard));
                const districtMatch = !targetDistrict || (kDistrict && (kDistrict.includes(targetDistrict) || targetDistrict.includes(kDistrict)));
                const cityMatch = !targetCity || (kCity && (kCity.includes(targetCity) || targetCity.includes(kCity)));

                if (wardMatch && districtMatch && cityMatch) {
                    const c = Object.assign({matchedKey: k}, v);
                    wardFallbackCache.set(cacheKey, c);
                    return c;
                }
            } catch (e) { }
        }
    }

    // fallback: if we have a district or city but not ward specifics, try any matching district or city
    if (targetDistrict || targetCity) {
        for (const [k, v] of wardIndex.entries()) {
            try {
                const parts = k.split('||');
                const kCity = alnum(parts[0] || '');
                const kDistrict = alnum(parts[1] || '');
                const cityMatch = !targetCity || (kCity && (kCity.includes(targetCity) || targetCity.includes(kCity)));
                const districtMatch = !targetDistrict || (kDistrict && (kDistrict.includes(targetDistrict) || targetDistrict.includes(kDistrict)));
                if (cityMatch && districtMatch) {
                    const c = Object.assign({matchedKey: k}, v);
                    wardFallbackCache.set(cacheKey, c);
                    return c;
                }
            } catch (e) { }
        }
    }

    wardFallbackCache.set(cacheKey, null);
    return null;
}

// Snap a customer record to the ward/district polygon centroid (if available)
function snapCustomerToWard(customer) {
    try {
        if (!customer || typeof customer !== 'object') return customer;
        // Skip snapping if customer already has a random position set
        if (customer.__useRandomPosition) return customer;
        const city = customer.city || '';
        const district = customer.district || '';
        const ward = customer.ward || '';
        if (!city && !district && !ward) return customer;
        // Skip snapping if customer already has valid coordinates (not 0,0)
        const curLat = Number(customer.latitude) || 0;
        const curLon = Number(customer.longitude) || 0;
        const curHasDecimals = (String(curLat).split('.')[1] || '').length >= 2 && (String(curLon).split('.')[1] || '').length >= 2;
        if (Number.isFinite(curLat) && Number.isFinite(curLon) && Math.abs(curLat) > 0.1 && Math.abs(curLon) > 100 && curLat >= -9.5 && curLat <= -6.0 && curLon >= 111.0 && curLon <= 116.5 && curHasDecimals) {
            return customer;
        }
        // Prefer polygon-derived ward index (authoritative), then CSV-provided ward coords
        let coord = null;
        coord = getCoordinateFromWard(city, district, ward) || getCoordinateFromCsvWard(city, district, ward);
        if (coord && coord.latitude != null && coord.longitude != null) {
            const out = Object.assign({}, customer);
            out.latitude = coord.latitude;
            out.longitude = coord.longitude;
            // Preserve original resolvedBy info but indicate snapping
            const prev = String(customer.resolvedBy || 'original');
            out.resolvedBy = prev + '|wardSnap';
            return out;
        }
    } catch (e) { /* ignore */ }
    return customer;
}

/* =========================================================
   PARSE CUSTOMER DATA
   ========================================================= */

function hasValidCustomerCoordinates(customer) {
    if (!customer || typeof customer !== 'object') return false;
    const lat = Number(customer.latitude);
    const lon = Number(customer.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
    if (Math.abs(lat) < 1e-6 || Math.abs(lon) < 1e-6) return false;
    if (!isWithinIndonesiaBounds(lat, lon)) return false;
    const latDecimals = (String(customer.latitude).split('.')[1] || '').length;
    const lonDecimals = (String(customer.longitude).split('.')[1] || '').length;
    return latDecimals >= 2 && lonDecimals >= 2;
}

function parseCustomerData(rowsOrText){

    const raw = Array.isArray(rowsOrText) ? rowsOrText : parseCSV(rowsOrText);
    console.log('[CUSTOMER_MAP] parseCustomerData raw rows=', raw.length);

    if(raw.length===0) return [];

    try { buildCsvWardCoordinateIndex(raw); } catch (e) { console.warn('buildCsvWardCoordinateIndex (FAT mode) failed', e); }

    const mapping = resolveFATHeaders(raw);
    if (!mapping || (!mapping.label && !mapping.site && !mapping.city && !mapping.id)) {
        console.error('[CUSTOMER_MAP] Tidak ada kolom dikenali di dataset. Header tersedia:', Object.keys(raw[0] || {}));
        return [];
    }

    const customers = [];

    let wardResolvedCount = 0;
    let defaultedCount = 0;

    for (let index = 0; index < raw.length; index++) {
        const row = raw[index];
        const customer = parseFATRow(row, mapping, index);
        if (!customer.label && !customer.site && !customer.id) continue;

        if (customer.resolvedBy === 'wardIndex') wardResolvedCount++;
        else if (customer.resolvedBy === 'default') defaultedCount++;

        // Snap to ward centroid (if available) so markers follow ward/district polygons
        const finalCustomer = snapCustomerToWard(customer);
        customers.push(finalCustomer);
    }

    console.log('parseCustomerData: totalRaw=', raw.length,
        'customersParsed=', customers.length,
        'wardResolved=', wardResolvedCount,
        'defaulted=', defaultedCount);

    return customers;

}


/* =========================================================
   MARKER STYLE
   ========================================================= */

// Use a Web Worker to parse large CSVs in background and return the parsed customers
function parseCustomerDataWithWorker(text, wardIndexEntries, options = {}) {
    return new Promise((resolve, reject) => {
        try {
            // Create worker relative to current script location
            const worker = new Worker('resources/customer-parser-worker.js');
            const timeout = options.timeout || 120000; // safety timeout
            let timedOut = false;
            const to = setTimeout(() => {
                timedOut = true;
                try { worker.terminate(); } catch (e) {}
                reject(new Error('customer-parser-worker timed out')); }, timeout);

            const onMessage = (ev) => {
                const d = ev.data || {};
                if (d.cmd === 'done') {
                    clearTimeout(to);
                    worker.removeEventListener('message', onMessage);
                    try { worker.terminate(); } catch (e) {}
                    resolve(d.customers || []);
                } else if (d.cmd === 'error') {
                    clearTimeout(to);
                    worker.removeEventListener('message', onMessage);
                    try { worker.terminate(); } catch (e) {}
                    reject(new Error(d.message || 'worker error'));
                }
            };

            worker.addEventListener('message', onMessage);
            worker.addEventListener('error', (err) => {
                clearTimeout(to);
                worker.removeEventListener('message', onMessage);
                try { worker.terminate(); } catch (e) {}
                reject(err || new Error('worker runtime error'));
            });

            // Send serialized wardIndex entries so worker can use wardIndex lookups
            const payload = { cmd: 'parse', text: text, wardIndexEntries: wardIndexEntries || [], options };
            worker.postMessage(payload);
        } catch (err) {
            reject(err);
        }
    });
}

/* Async chunked parser to avoid long main-thread blocks when parsing large CSVs.
   Options: { chunkSize: number }
*/
function parseCustomerDataAsync(text, options = {}) {
    const chunkSize = options.chunkSize || 1000;
    return new Promise((resolve, reject) => {
        try {
            const raw = Array.isArray(text) ? text : parseCSV(text);
            console.log('[CUSTOMER_MAP] parseCustomerDataAsync raw rows=', raw.length);
            if (!Array.isArray(raw) || raw.length === 0) return resolve([]);

            // build index once
            try { buildCsvWardCoordinateIndex(raw); } catch (e) { console.warn('buildCsvWardCoordinateIndex (FAT mode) failed', e); }

            const mapping = resolveFATHeaders(raw);
            if (!mapping || (!mapping.label && !mapping.site && !mapping.city && !mapping.id)) {
                console.error('[CUSTOMER_MAP] parseCustomerDataAsync: header tidak dikenali');
                return resolve([]);
            }

            const customers = [];

            let wardResolvedCount = 0;
            let defaultedCount = 0;

            let i = 0;
            const N = raw.length;

            const processChunk = () => {
                const end = Math.min(i + chunkSize, N);
                for (; i < end; i++) {
                    const row = raw[i];
                    const customer = parseFATRow(row, mapping, i);
                    if (!customer.label && !customer.site && !customer.id) continue;

                    if (customer.resolvedBy === 'wardIndex') wardResolvedCount++;
                    else if (customer.resolvedBy === 'default') defaultedCount++;

                    customers.push(customer);
                }

                if (i < N) {
                    // yield to event loop
                    setTimeout(processChunk, 0);
                } else {
                    // done
                    console.log('parseCustomerDataAsync: totalRaw=', raw.length,
                        'customersParsed=', customers.length,
                        'wardResolved=', wardResolvedCount,
                        'defaulted=', defaultedCount);
                    resolve(customers);
                }
            };

            processChunk();
        } catch (e) {
            reject(e);
        }
    });
}

/* =========================================================
   MARKER STYLE
   ========================================================= */

function createMarkerStyle(customer) {

    if (typeof DEBUG_HIGHLIGHT_MARKERS !== 'undefined' && DEBUG_HIGHLIGHT_MARKERS) {
        // High-visibility debug style
        return new ol.style.Style({
            image: new ol.style.Circle({
                radius: 12,
                fill: new ol.style.Fill({ color: 'rgba(220,20,60,0.95)' }), // crimson
                stroke: new ol.style.Stroke({ color: '#000000', width: 2 })
            })
        });
    }

    return new ol.style.Style({

        image: new ol.style.Circle({

            radius: 7,

            fill: new ol.style.Fill({
                color: getPortStatusColor(customer)
            }),

            stroke: new ol.style.Stroke({
                color: "#ffffff",
                width: 2
            })

        })

    });

}

/* =========================================================
   CREATE MAP LAYER
   ========================================================= */

function createCustomerLayer() {

    // Avoid recreating layer if it already exists (prevents other scripts from wiping it)
    if (customerLayer && customerSource) {
        try { if (typeof customerLayer.setZIndex === 'function') customerLayer.setZIndex(99999); } catch(e){}
        try {
            if (typeof map !== 'undefined' && map && typeof map.getLayers === 'function') {
                const layers = map.getLayers().getArray();
                if (!layers.includes(customerLayer)) {
                    map.addLayer(customerLayer);
                }
                // ensure expanded layer exists and is added
                if (!customerExpandedLayer && typeof ol !== 'undefined') {
                    try {
                        customerExpandedSource = new ol.source.Vector();
                        customerExpandedLayer = new ol.layer.Vector({ source: customerExpandedSource, renderMode: 'vector', declutter: false, style: (feature) => customerLayer.getStyle()(feature) });
                        map.addLayer(customerExpandedLayer);
                        try { if (typeof customerExpandedLayer.setZIndex === 'function') customerExpandedLayer.setZIndex(100000); } catch(e){}
                    } catch (e) { /* ignore */ }
                } else if (customerExpandedLayer && !layers.includes(customerExpandedLayer)) {
                    try { map.addLayer(customerExpandedLayer); } catch(e){}
                }
            }
        } catch (e) {
            console.warn('createCustomerLayer: failed to re-add existing customer layer', e);
        }
        return;
    }

    // remove any stale customer layers remaining from previous script reloads
    try {
        removeStaleCustomerLayers();
    } catch (e) {
        console.warn('createCustomerLayer: failed to cleanup existing customer layers', e);
    }

    customerSource = new ol.source.Vector();

    // Shared style cache and style function to avoid creating one style per feature (big perf win)
    if (!window._customer_style_cache) window._customer_style_cache = {};
    const customerStyleFunction = function(feature) {
        const customer = feature.get('customer') || {};
        const key = getPortStatusKey(customer);
        if (window._customer_style_cache[key]) return window._customer_style_cache[key];
        // Create a single shared style per status
        const st = new ol.style.Style({
            image: new ol.style.Circle({
                radius: (typeof DEBUG_HIGHLIGHT_MARKERS !== 'undefined' && DEBUG_HIGHLIGHT_MARKERS) ? 12 : 7,
                fill: new ol.style.Fill({ color: (typeof DEBUG_HIGHLIGHT_MARKERS !== 'undefined' && DEBUG_HIGHLIGHT_MARKERS) ? 'rgba(220,20,60,0.95)' : PORT_STATUS_CONFIG[key].color }),
                stroke: new ol.style.Stroke({ color: (typeof DEBUG_HIGHLIGHT_MARKERS !== 'undefined' && DEBUG_HIGHLIGHT_MARKERS) ? '#000' : '#ffffff', width: 2 })
            })
        });
        window._customer_style_cache[key] = st;
        return st;
    };

    customerLayer = new ol.layer.Vector({

            source: customerSource,

            // render as image for faster drawing of many points (reduces DOM/Canvas pressure)
            renderMode: 'image',
            declutter: true,

            style: customerStyleFunction

        });

        // mark layer with expected properties so other logic and interactions can find it
        try { customerLayer.set('customerLayer', true); } catch (e) {}
        try { customerLayer.set('title', 'Customer'); } catch (e) {}
        try { customerLayer.set('interactive', true); } catch (e) {}

        // Create an expanded-layer used when we need to show individual group members without decluttering
        try {
            customerExpandedSource = new ol.source.Vector();
            customerExpandedLayer = new ol.layer.Vector({
                source: customerExpandedSource,
                // do not declutter and render normally so overlapping markers can be spiderfied/offset
                renderMode: 'vector',
                declutter: false,
                style: customerStyleFunction
            });
            try { customerExpandedLayer.set('expandedCustomerLayer', true); } catch (e) {}
            try { customerExpandedLayer.set('title', 'Customer (expanded)'); } catch (e) {}
            if (typeof map !== 'undefined' && map && typeof map.getLayers === 'function') {
                // Add expanded layer above base customer layer
                map.addLayer(customerExpandedLayer);
                try { if (typeof customerExpandedLayer.setZIndex === 'function') customerExpandedLayer.setZIndex(100000); } catch(e){}
            }
        } catch (e) { /* ignore expanded layer creation failures */ }
    if (typeof map === 'undefined') {
        console.error('createCustomerLayer: OpenLayers map is undefined.');
        return;
    }

    map.addLayer(customerLayer);
    try {
        if (typeof customerLayer.setZIndex === 'function') customerLayer.setZIndex(99999);
    } catch(e){ }
}

/* =========================================================
   DRAW MARKERS
   ========================================================= */

function drawCustomers(data, options){

    customerDrawVersion++;

    console.log('drawCustomers: incoming data length=', Array.isArray(data)?data.length:0, 'drawVersion=', customerDrawVersion);

    if(!customerSource) {
        console.error('drawCustomers: customerSource is not initialized');
        return;
    }

    if (customerDrawTimeout) {
        try { clearTimeout(customerDrawTimeout); } catch (e) { }
        customerDrawTimeout = null;
    }

    try { if (customerSource && typeof customerSource.clear === 'function') customerSource.clear(); } catch (e) {}
    try { if (customerLayer && customerLayer.getSource && customerLayer.getSource() && typeof customerLayer.getSource().clear === 'function') customerLayer.getSource().clear(); } catch (e) {}
    try { if (customerExpandedSource && typeof customerExpandedSource.clear === 'function') customerExpandedSource.clear(); } catch (e) {}
    try { if (customerExpandedLayer && customerExpandedLayer.getSource && customerExpandedLayer.getSource() && typeof customerExpandedLayer.getSource().clear === 'function') customerExpandedLayer.getSource().clear(); } catch (e) {}

    const originalFeatures = [];
    const adjustedFeatures = [];
    const skippedSamples = [];

    // Allow option to expand group members into individual markers when requested
    // If options.expandGroups is true, render one marker per input row instead of aggregating by ID.
    const opts = options || {};
    const expandGroups = !!opts.expandGroups;

    const makeFeature = customer => {
        const feat = new ol.Feature({
            geometry: new ol.geom.Point(
                ol.proj.fromLonLat([
                    Number(customer.longitude),
                    Number(customer.latitude)
                ])
            ),
            customer
        });
        try{ feat.set('drawVersion', customerDrawVersion); }catch(e){}
        try{ if (customer && typeof customer === 'object') customer.__drawVersion = customerDrawVersion; }catch(e){}
        return feat;
    };

    let individualCount = 0;

    let idMap = new Map();

    if (expandGroups) {
        // Build groupMembers index: group all rows by id_customer so popup can show duplicates
        const groupIdMap = new Map();
        data.forEach(customer => {
            const cid = String(customer.id || '').trim();
            if (!cid) return;
            if (!groupIdMap.has(cid)) groupIdMap.set(cid, []);
            groupIdMap.get(cid).push(customer);
        });

        // Render a feature for every input row (useful when filtering by ward/district to show all group members)
        // Place each marker at a random point within its ward polygon to avoid overlap and keep them within boundaries.
        let randPtCount = 0, fallbackCount = 0, origCoordsCount = 0, wardNotFound = new Set();
        
        // Helper: generate a small random scatter offset (~30m) for fallback when no polygon is found
        const smallRandomOffset = (baseLat, baseLon, idx, total) => {
            const metersToDeg = m => m / 111320.0;
            const lonScale = Math.cos(baseLat * Math.PI / 180) || 1;
            // Random angle and radius up to ~50 meters, with slight spiral to separate overlapping markers
            const angle = (2 * Math.PI * idx / Math.max(total, 1)) + (Math.random() * 0.5);
            const radius = metersToDeg(20 + Math.random() * 280); // 20-300m random spread
            return {
                latitude: baseLat + radius * Math.sin(angle),
                longitude: baseLon + (radius * Math.cos(angle)) / lonScale
            };
        };

        data.forEach((customer, idx) => {
            const hasOriginalPoint = hasValidCustomerCoordinates(customer);

            // Try random polygon point only when original coordinates are missing or invalid.
            let randPt = hasOriginalPoint ? null : getRandomPointInWard(customer.city, customer.district, customer.ward);

            // Fallback: direct lookup in wardPolygonIndex with multiple key variants
            if (!randPt && !hasOriginalPoint && wardPolygonIndex.size > 0) {
                const nc = normalize(customer.city || '');
                const nd = normalize(customer.district || '');
                const nw = normalize(customer.ward || '');
                const strippedNd = normalize(stripAdminPrefixes(customer.district || ''));
                const nwShort = normalize(shortWardName(customer.ward || ''));
                const nwNoSpace = normalize((customer.ward || '').replace(/\s+/g, ''));
                const wardKeys = [nw, nwShort, normalize(stripAdminPrefixes(customer.ward || '')), nwNoSpace].filter(Boolean);
                const districtKeys = [nd, strippedNd].filter(Boolean);
                const cityKeys = [nc, normalize(stripAdminPrefixes(customer.city || ''))].filter(Boolean);
                for (const ck of cityKeys) {
                    for (const dk of districtKeys) {
                        for (const wk of wardKeys) {
                            const key = normalizeLocationKey(ck, dk, wk);
                            if (wardPolygonIndex.has(key)) {
                                randPt = getRandomPointInPolygonRings(wardPolygonIndex.get(key));
                                if (randPt) break;
                            }
                        }
                        if (randPt) break;
                    }
                    if (randPt) break;
                }
                // Fuzzy: match by partial ward name within same district
                if (!randPt) {
                    const targetWard = normalizeKey(nw);
                    const targetDistrict = normalizeKey(nd);
                    for (const [key, rings] of wardPolygonIndex.entries()) {
                        try {
                            const parts = key.split('||').map(p => normalizeKey(p || ''));
                            const kDistrict = parts[1] || '';
                            const kWard = parts[2] || '';
                            const wardMatch = targetWard && kWard && (kWard.includes(targetWard) || targetWard.includes(kWard));
                            const districtMatch = !targetDistrict || (kDistrict && (kDistrict.includes(targetDistrict) || targetDistrict.includes(kDistrict)));
                            if (wardMatch && districtMatch) {
                                randPt = getRandomPointInPolygonRings(rings);
                                if (randPt) break;
                            }
                        } catch(e) {}
                    }
                }
                // Final fallback: pick any random polygon from the same district
                if (!randPt && nd) {
                    const targetDistrict = normalizeKey(nd);
                    const sameDistrict = [];
                    for (const [key, rings] of wardPolygonIndex.entries()) {
                        try {
                            const parts = key.split('||').map(p => normalizeKey(p || ''));
                            const kDistrict = parts[1] || '';
                            if (kDistrict && (kDistrict.includes(targetDistrict) || targetDistrict.includes(kDistrict))) {
                                sameDistrict.push(rings);
                            }
                        } catch(e) {}
                    }
                    if (sameDistrict.length > 0) {
                        const pick = sameDistrict[Math.floor(Math.random() * sameDistrict.length)];
                        randPt = getRandomPointInPolygonRings(pick);
                    }
                }
            }

            let c;
            if (hasOriginalPoint) {
                c = Object.assign({}, customer);
                c.__useRandomPosition = false;
                origCoordsCount++;
            } else if (randPt) {
                // Polygon found: use random point only when there is no valid coordinate to preserve site accuracy.
                randPtCount++;
                c = Object.assign({}, customer);
                c.latitude = randPt.latitude;
                c.longitude = randPt.longitude;
                c.__useRandomPosition = true;
                c.resolvedBy = (customer.resolvedBy || 'original') + '|randomInPolygon';
            } else {
                // No polygon found: if customer already has valid coordinates, keep them as-is.
                const origLat = Number(customer.latitude) || 0;
                const origLon = Number(customer.longitude) || 0;
                const hasDecimals = (String(origLat).split('.')[1] || '').length >= 2 && (String(origLon).split('.')[1] || '').length >= 2;
                const hasValidCoords = Number.isFinite(origLat) && Number.isFinite(origLon) && Math.abs(origLat) > 0.1 && Math.abs(origLon) > 100 && origLat >= -9.5 && origLat <= -6.0 && origLon >= 111.0 && origLon <= 116.5 && hasDecimals;
                if (hasValidCoords) {
                    c = Object.assign({}, customer);
                    c.__useRandomPosition = false;
                    origCoordsCount++;
                } else {
                    // No valid coords: fall back to snapCustomerToWard (centroid) without random scatter.
                    fallbackCount++;
                    wardNotFound.add(customer.ward + '|' + customer.district);
                    c = snapCustomerToWard(customer);
                    const baseLat = Number(c.latitude) || 0;
                    const baseLon = Number(c.longitude) || 0;
                    if (!Number.isFinite(baseLat) || !Number.isFinite(baseLon) || Math.abs(baseLat) <= 1e-6 || Math.abs(baseLon) <= 1e-6) {
                        if (skippedSamples.length < 20) skippedSamples.push({id: c.id, lat: c.latitude, lon: c.longitude});
                        return;
                    }
                    c.__useRandomPosition = false;
                }
            }
            const lat = Number(c.latitude);
            const lon = Number(c.longitude);
            if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) <= 1e-6 || Math.abs(lon) <= 1e-6) {
                if (skippedSamples.length < 20) skippedSamples.push({id: c.id, lat: c.latitude, lon: c.longitude});
                return;
            }
            if (idx < 20) console.log('[DRAW] ward=' + customer.ward + ' district=' + customer.district + ' randPt=' + (randPt ? 'YES' : 'NO') + ' lat=' + (randPt ? randPt.latitude : c.latitude) + ' lon=' + (randPt ? randPt.longitude : c.longitude) + ' resolvedBy=' + (c.resolvedBy || 'original'));
            // Attach groupMembers from id_customer duplicates
            const cid = String(c.id || '').trim();
            const members = cid ? groupIdMap.get(cid) : null;
            if (members && members.length > 1) {
                c.groupMembers = members;
                c.groupCount = members.length;
            }
            const feature = makeFeature(c);
            if (c.resolvedBy && c.resolvedBy !== 'original') adjustedFeatures.push(feature); else originalFeatures.push(feature);
            individualCount++;
        })
        console.log('[DRAW] SUMMARY: total=' + data.length + ' randPt=' + randPtCount + ' origCoords=' + origCoordsCount + ' fallback(centroid)=' + fallbackCount + ' wardsNoPolygon=' + Array.from(wardNotFound).join('; '));

    } else {
        // Group customers by ID. Same customer ID with multiple records → single marker with group members.
        idMap = new Map();

        data.forEach((customer, idx) => {
            if (idx < 10) {
                try { console.log(`drawCustomers: sample[${idx}] id=${customer.id} lat=${customer.latitude} lon=${customer.longitude} resolvedBy=${customer.resolvedBy || 'original'}`); } catch(e) {}
            }
            const custId = String(customer.id || '').trim();
            const key = custId ? `id::${custId}` : `unknown::${idx}`;
            if (!idMap.has(key)) idMap.set(key, []);
            idMap.get(key).push(customer);
        });

        const chooseRepresentative = items => items.find(m => {
            const la = Number(m.latitude);
            const lo = Number(m.longitude);
            return Number.isFinite(la) && Number.isFinite(lo) && Math.abs(la) > 1e-6 && Math.abs(lo) > 1e-6;
        }) || items[0];

        for (const [groupKey, members] of idMap.entries()) {
            if (!members || members.length === 0) continue;

            if (members.length === 1) {
                let customer = members[0];
                // ensure marker follows ward/district polygon if available
                customer = snapCustomerToWard(customer);
                const lat = Number(customer.latitude);
                const lon = Number(customer.longitude);
                if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) > 1e-6 && Math.abs(lon) > 1e-6) {
                    const feature = makeFeature(customer);
                    if (customer.resolvedBy && customer.resolvedBy !== 'original') adjustedFeatures.push(feature); else originalFeatures.push(feature);
                    individualCount++;
                } else {
                    if (skippedSamples.length < 20) skippedSamples.push({id: customer.id, lat: customer.latitude, lon: customer.longitude});
                }
                continue;
            }

            // Multiple records for same customer ID: prefer the original site coordinates when valid.
            const rep = chooseRepresentative(members);
            const city = rep.city || members[0].city || '';
            const district = rep.district || members[0].district || '';
            const ward = rep.ward || members[0].ward || '';

            let coord = null;
            if (hasValidCustomerCoordinates(rep)) {
                coord = { latitude: Number(rep.latitude), longitude: Number(rep.longitude) };
            } else {
                coord = getCoordinateFromCsvWard(city, district, ward) || getCoordinateFromWard(city, district, ward) || getRandomPointInWard(city, district, ward);
            }

            if (!coord) {
                if (skippedSamples.length < 20) skippedSamples.push({id: groupKey, count: members.length, city, district, ward});
                continue;
            }

            let sampleCustomer = {
                id: rep.id || groupKey,
                username: rep.username || '',
                city: city,
                district: district,
                ward: ward,
                site: rep.site || '',
                team: rep.team || '',
                vendor: rep.vendor || '',
                status: rep.status || '',
                visitDate: rep.visitDate || '',
                latitude: coord.latitude,
                longitude: coord.longitude,
                groupCount: members.length,
                groupMembers: members,
                dataFatFull: rep.dataFatFull || {},
                resolvedBy: (rep.resolvedBy || 'original') + '|idGroup'
            };

            // ensure group representative marker follows ward/district polygon if available (idempotent)
            sampleCustomer = snapCustomerToWard(sampleCustomer);
            const feature = makeFeature(sampleCustomer);
            if (sampleCustomer.resolvedBy && sampleCustomer.resolvedBy !== 'original') adjustedFeatures.push(feature); else originalFeatures.push(feature);
        }
    }

    const totalFeatures = originalFeatures.length + adjustedFeatures.length;
    console.log('drawCustomers: immediateFeatures=', originalFeatures.length, 'adjustedFeatures=', adjustedFeatures.length, 'skippedSamples=', skippedSamples.length, 'individualCount=', individualCount, 'idGroups=', idMap.size, 'totalFeatures=', totalFeatures);

    try {
        if (typeof map !== 'undefined' && map && map.getView && typeof map.getView === 'function') {
            const center = ol.proj.toLonLat(map.getView().getCenter());
            console.log('drawCustomers: map center (lon,lat)=', center, 'zoom=', map.getView().getZoom());
        }
    } catch (e) {}

    const addFeaturesInBatches = (features, chunkSize = 5000, targetSource = customerSource) => {
        const drawVersion = customerDrawVersion;
        let added = 0;
        const addBatch = () => {
            if (drawVersion !== customerDrawVersion) return;
            const chunk = features.slice(added, added + chunkSize);
            if (chunk.length === 0) return;
            try {
                targetSource.addFeatures(chunk);
                added += chunk.length;
                if (typeof map !== 'undefined' && map && typeof map.render === 'function') {
                    try { map.render(); } catch (e) {}
                }
                // remove any leftover features from previous draws whose drawVersion doesn't match
                try{
                    const all = targetSource.getFeatures();
                    for (let i = all.length - 1; i >= 0; i--) {
                        const f = all[i];
                        const dv = f.get && f.get('drawVersion');
                        if (dv !== drawVersion) {
                            targetSource.removeFeature(f);
                        }
                    }
                }catch(e){}
            } catch (e) {
                console.error('drawCustomers: error adding feature chunk', e);
            }
            if (added < features.length && drawVersion === customerDrawVersion) {
                customerDrawTimeout = setTimeout(addBatch, 0);
            }
        };
        addBatch();
    };

    const targetSourceForOriginal = expandGroups && customerExpandedSource ? customerExpandedSource : customerSource;
    const targetSourceForAdjusted = expandGroups && customerExpandedSource ? customerExpandedSource : customerSource;

    if (originalFeatures.length > 0) {
        if (originalFeatures.length <= 5000) {
            try { targetSourceForOriginal.addFeatures(originalFeatures); } catch (e) { addFeaturesInBatches(originalFeatures, 5000, targetSourceForOriginal); }
        } else {
            addFeaturesInBatches(originalFeatures, 5000, targetSourceForOriginal);
        }
    }

    if (adjustedFeatures.length > 0) {
        customerDrawTimeout = setTimeout(() => {
            const active = (drawVersion => {
                if (drawVersion !== customerDrawVersion) return false;
                addFeaturesInBatches(adjustedFeatures, 3000, targetSourceForAdjusted);
                return true;
            })(customerDrawVersion);
            if (!active) customerDrawTimeout = null;
        }, 0);
    }

    if (originalFeatures.length === 0 && adjustedFeatures.length === 0) {
        console.warn('drawCustomers: no features added after grouping');
    }

    try {
        if (typeof map !== 'undefined' && map && typeof map.getLayers === 'function') {
            if (customerLayer && typeof customerLayer.setZIndex === 'function') customerLayer.setZIndex(99999);
        }
    } catch (e) {}
}


/* =========================================================
   POPUP
   ========================================================= */

// ==========================
// MARKER EDITING
// ==========================
let markerEditEnabled = false;
let markerTranslateInteraction = null;

function setupMarkerEditingControl() { return; // disabled per user request - do not create edit markers UI

    // Robustly add the edit control; retry briefly if DOM element isn't ready yet.
    if (setupMarkerEditingControl._initialized) return;
    setupMarkerEditingControl._initialized = true;
    console.log('setupMarkerEditingControl: start');

    const makeAndInsert = () => {
        try {
            const btn = document.createElement('button');
            btn.id = 'marker-edit-toggle';
            btn.className = 'marker-edit-toggle';
            btn.type = 'button';
            btn.setAttribute('aria-label', 'Toggle marker edit');
            btn.title = 'Enable marker edit (drag markers)';
            btn.style.padding = '6px 8px';
            btn.style.margin = '4px';
            btn.style.background = '#fff';
            btn.style.border = '1px solid #ccc';
            btn.style.cursor = 'pointer';
            btn.style.fontSize = '13px';
            btn.textContent = '✏️ Edit markers';

            btn.addEventListener('click', function() {
                toggleMarkerEditing();
                btn.textContent = markerEditEnabled ? '⏹ Stop editing' : '✏️ Edit markers';
                btn.style.background = markerEditEnabled ? '#fee' : '#fff';
                // sync floating button label if present
                const fb = document.getElementById('marker-edit-floating'); if (fb) fb.textContent = markerEditEnabled ? 'Stop editing' : 'Edit markers';
            });

            const wrapper = document.createElement('div');
            wrapper.className = 'ol-control ol-unselectable marker-edit-control';
            wrapper.style.display = 'inline-block';
            wrapper.style.padding = '2px';
            wrapper.style.background = 'transparent';
            wrapper.appendChild(btn);

            const parent = document.getElementById('top-left-container');
            if (parent && parent.appendChild) {
                parent.appendChild(wrapper);
                console.log('setupMarkerEditingControl: appended to #top-left-container');
                return true;
            }

            if (typeof map !== 'undefined' && map && typeof ol !== 'undefined' && ol.control) {
                try {
                    map.addControl(new ol.control.Control({ element: wrapper }));
                    console.log('setupMarkerEditingControl: added control via map.addControl');
                    return true;
                } catch (e) {
                    console.warn('setupMarkerEditingControl: map.addControl failed', e);
                }
            }

            // fallback to body
            document.body.appendChild(wrapper);
            console.log('setupMarkerEditingControl: appended to document.body (fallback)');
            return true;
        } catch (e) {
            console.warn('setupMarkerEditingControl makeAndInsert error', e);
            return false;
        }
    };

    // Always create a floating visible button as a guaranteed fallback (high z-index)
    const makeFloatingButton = () => {
        try {
            if (document.getElementById('marker-edit-floating')) return;
            const fb = document.createElement('button');
            fb.id = 'marker-edit-floating';
            fb.type = 'button';
            fb.title = 'Edit markers';
            fb.style.position = 'fixed';
            fb.style.right = '16px';
            fb.style.bottom = '16px';
            fb.style.zIndex = '2147483647';
            fb.style.background = '#007bff';
            fb.style.color = '#fff';
            fb.style.border = 'none';
            fb.style.padding = '10px 14px';
            fb.style.borderRadius = '6px';
            fb.style.boxShadow = '0 2px 6px rgba(0,0,0,0.3)';
            fb.style.cursor = 'pointer';
            fb.style.fontSize = '14px';
            fb.textContent = '✏️ Edit markers';
            fb.addEventListener('click', function() {
                toggleMarkerEditing();
                fb.textContent = markerEditEnabled ? '⏹ Stop editing' : '✏️ Edit markers';
                const domBtn = document.getElementById('marker-edit-toggle'); if (domBtn) domBtn.textContent = markerEditEnabled ? '⏹ Stop editing' : '✏️ Edit markers';
            });
            document.body.appendChild(fb);
            console.log('setupMarkerEditingControl: floating button added');
        } catch (e) { console.warn('setupMarkerEditingControl makeFloatingButton error', e); }
    };

    // Try immediate insert, otherwise retry for up to 2 seconds
    if (makeAndInsert()) { makeFloatingButton(); return; }
    const start = Date.now();
    const interval = setInterval(() => {
        if (makeAndInsert()) {
            makeFloatingButton();
            clearInterval(interval);
            return;
        }
        if (Date.now() - start > 2000) {
            // always ensure floating button appears as last resort
            makeFloatingButton();
            clearInterval(interval);
            console.warn('setupMarkerEditingControl: giving up after retries, floating button added');
        }
    }, 100);
}

function toggleMarkerEditing(enable) {
    try {
        if (typeof enable === 'boolean') {
            if (enable === markerEditEnabled) return;
            markerEditEnabled = enable;
        } else {
            markerEditEnabled = !markerEditEnabled;
        }

        if (!map) {
            console.warn('toggleMarkerEditing: map undefined');
            return;
        }

        // remove existing interaction
        if (markerTranslateInteraction) {
            try { map.removeInteraction(markerTranslateInteraction); } catch (e) {}
            markerTranslateInteraction = null;
        }

        if (!markerEditEnabled) {
            return;
        }

        if (typeof customerLayer === 'undefined' || !customerLayer) {
            console.warn('toggleMarkerEditing: customerLayer not available');
            markerEditEnabled = false;
            return;
        }

        // Create Translate interaction restricted to customerLayer
        markerTranslateInteraction = new ol.interaction.Translate({
            layers: function(layer) {
                try { return layer === customerLayer || (layer && layer.get && layer.get('customerLayer') === true); } catch (e) { return false; }
            },
            // small hit tolerance to make dragging easier on touch
            hitTolerance: 6
        });

        markerTranslateInteraction.on('translateend', function(evt) {
            try {
                // evt.features is a Collection in some ol versions, or evt.feature
                const features = (evt.features && typeof evt.features.getArray === 'function') ? evt.features.getArray() : (evt.feature ? [evt.feature] : []);
                for (const f of features) {
                    if (!f) continue;
                    const geom = f.getGeometry && f.getGeometry();
                    if (!geom) continue;
                    const coords = geom.getCoordinates();
                    const lonlat = ol.proj.toLonLat(coords);
                    const lon = Number(lonlat[0]);
                    const lat = Number(lonlat[1]);

                    // Update attached customer object if present
                    try {
                        const c = f.get('customer');
                        if (c && typeof c === 'object') {
                            c.latitude = lat;
                            c.longitude = lon;
                            // mark as edited
                            c.__edited = true;
                            // sync back to feature property
                            f.set('customer', c);
                        }
                    } catch (e) { }

                    // Also, update any internal customers array entry if possible (match by id)
                    try {
                        const cust = f.get('customer');
                        if (cust && cust.id && Array.isArray(customers)) {
                            const idx = customers.findIndex(x => String(x.id) === String(cust.id));
                            if (idx >= 0) {
                                customers[idx].latitude = lat;
                                customers[idx].longitude = lon;
                                customers[idx].__edited = true;
                            }
                        }
                    } catch (e) { }
                }

                // Optionally show a small confirmation in popup
                try {
                    const popup = document.getElementById('popup-content');
                    if (popup) {
                        popup.innerHTML = '<div class="customer-popup"><p>Marker posisi diperbarui. Jangan lupa menyimpan perubahan.</p></div>';
                        if (typeof container !== 'undefined') container.style.display = 'block';
                        if (typeof overlayPopup !== 'undefined') {
                            // place near first moved feature
                            const first = features && features[0];
                            if (first) {
                                const p = ol.proj.toLonLat(first.getGeometry().getCoordinates());
                                overlayPopup.setPosition(ol.proj.fromLonLat([p[0], p[1]]));
                            }
                        }
                    }
                } catch (e) { }

            } catch (e) { console.warn('marker translateend handler failed', e); }
        });

        map.addInteraction(markerTranslateInteraction);

    } catch (e) { console.warn('toggleMarkerEditing failed', e); }
}

function showCustomerPopup(customer, feature) {

    const popup =
        document.getElementById(
            "popup-content"
        );

    const statusKey =
        getStatusKey(
            customer.status
        );

    const statusColor =
        STATUS_CONFIG[
            statusKey
        ].color;

    let gps = "";

    if (
Number.isFinite(customer.latitude) &&
Number.isFinite(customer.longitude)
    ) {

        gps =
            `
            <a
                class="gps-button"
                target="_blank"
                href="https://www.google.com/maps/dir/?api=1&destination=${customer.latitude},${customer.longitude}"
            >
                📍 Buka GPS / Google Maps
            </a>
            `;

    }

    const getRawData = item => {
        if (item && item.dataFatFull && typeof item.dataFatFull === 'object') {
            return item.dataFatFull;
        }
        return {};
    };

    // A marker represents one ID; show only the row belonging to the clicked marker.
    const rawMembers = [customer];
    const metricHeaders = new Set([
        'jumlah splitter',
        'total port',
        'total used (visual)',
        'total idle (visual)'
    ]);
    const hiddenMarkerHeaders = new Set([
        'kota/kabupaten',
        'site id',
        'nama site',
        'label',
        'user latitude',
        'user longitude',
        'latitude',
        'longitude',
        'tipe fat'
    ]);
    const rawHeaders = [...new Set(rawMembers.flatMap(item => Object.keys(getRawData(item))))]
        .filter(header => !hiddenMarkerHeaders.has(String(header).trim().toLowerCase()) &&
            (metricHeaders.has(String(header).trim().toLowerCase()) ||
            rawMembers.some(item => {
                const value = getRawData(item)[header];
                return value !== undefined && value !== null && String(value).trim() !== '';
            })));
    const allDataRows = rawMembers.map(item => {
        const raw = getRawData(item);
        return `
            <tr style="border-bottom:1px solid #eee;">
                ${rawHeaders.map(header => {
                    const value = raw[header];
                    return `<td style="padding:3px 6px;">${escapeHtml(value === undefined || value === null || String(value).trim() === '' ? '-' : String(value))}</td>`;
                }).join('')}
            </tr>
        `;
    }).join('');
    const allDataHtml = rawHeaders.length > 0 ? `
        <tr>
            <td colspan="2" style="vertical-align:top;">
                <div style="max-height:360px; overflow:auto; border:1px solid #ddd; border-radius:4px;">
                    <table style="width:100%; border-collapse:collapse; font-size:11px;">
                        <thead>
                            <tr style="background:#f5f5f5; position:sticky; top:0;">
                                ${rawHeaders.map(header => `<th style="padding:3px 6px; text-align:left; border-bottom:2px solid #ccc; white-space:nowrap;">${escapeHtml(header)}</th>`).join('')}
                            </tr>
                        </thead>
                        <tbody>${allDataRows}</tbody>
                    </table>
                </div>
            </td>
        </tr>
    ` : '';

    const idDisplay = customer.id || '';

    popup.innerHTML = `

        <div class="customer-popup">

            <table>

                <tr>
                    <td>Label</td>
                    <td>${escapeHtml(customer.label || customer.username || idDisplay)}</td>
                </tr>

                <tr>
                    <td>ID</td>
                    <td>${escapeHtml(idDisplay)}</td>
                </tr>

                <tr>
                    <td>Kota/Kabupaten</td>
                    <td>${escapeHtml(customer.city)}</td>
                </tr>

                ${customer.district ? `
                <tr>
                    <td>Kecamatan</td>
                    <td>${escapeHtml(customer.district)}</td>
                </tr>
                ` : ''}

                ${customer.ward ? `
                <tr>
                    <td>Kelurahan</td>
                    <td>${escapeHtml(customer.ward)}</td>
                </tr>
                ` : ''}

                <tr>
                    <td>Nama Site</td>
                    <td>${escapeHtml(customer.site)}</td>
                </tr>

                ${customer.resolvedBy && customer.resolvedBy !== 'original' ? `
                <!--
                <tr>
                    <td>Resolved By</td>
                    <td>${customer.resolvedBy}</td>
                </tr>
        -->
                ` : ''}

                <tr>
                    <td>Keterangan</td>

                    <td style="
                        font-weight:bold;
                        color:${statusColor};
                    ">
                        ${escapeHtml(customer.ket || customer.status || '-')}
                    </td>
                </tr>
                ${customer.visitDate ? `
                <tr>
                    <td>Tanggal</td>
                    <td>${escapeHtml(customer.visitDate)}</td>
                </tr>
                ` : ''}

                ${allDataHtml}

            </table>

            ${gps}

        </div>

    `;

    try {
        if (typeof container !== 'undefined') container.style.display = 'block';
        if (typeof overlayPopup !== 'undefined') {
            overlayPopup.setPosition(
                ol.proj.fromLonLat([
                    customer.longitude,
                    customer.latitude
                ])
            );
        }

    } catch (e) { console.warn('showCustomerPopup overlay error', e); }

}


/* =========================================================
   MAP CLICK
   ========================================================= */

// =========================================================
// DEVICE GEOLOCATION (show current device location on map)
// =========================================================
function createUserLocationLayer() {
    try {
        if (userLocationLayer) return;
        if (typeof ol === 'undefined' || typeof map === 'undefined') return;
        userLocationLayer = new ol.layer.Vector({
            source: new ol.source.Vector(),
            zIndex: 2147483646,
            style: function(feature) {
                try {
                    if (!feature) return null;
                    const t = feature.get('type');
                    if (t === 'accuracy') {
                        return new ol.style.Style({
                            fill: new ol.style.Fill({ color: 'rgba(33,150,243,0.12)' }),
                            stroke: new ol.style.Stroke({ color: 'rgba(33,150,243,0.35)', width: 1 })
                        });
                    }
                    // default: position icon (emoji)
                    return new ol.style.Style({
                        text: new ol.style.Text({
                            text: '📍',
                            font: '24px sans-serif',
                            fill: new ol.style.Fill({ color: '#d32f2f' }),
                            stroke: new ol.style.Stroke({ color: '#ffffff', width: 3 }),
                            offsetY: 0
                        })
                    });
                } catch (e) { return null; }
            }
        });
        try { map.addLayer(userLocationLayer); } catch (e) { console.warn('createUserLocationLayer addLayer failed', e); }
    } catch (e) { console.warn('createUserLocationLayer failed', e); }
}

function showUserLocation(latitude, longitude, accuracyMeters) {
    try {
        if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return;
        createUserLocationLayer();
        if (!userLocationLayer) return;
        const src = userLocationLayer.getSource();
        try { src.clear(); } catch (e) {}
        const coords = ol.proj.fromLonLat([Number(longitude), Number(latitude)]);
        userLocationFeature = new ol.Feature({ geometry: new ol.geom.Point(coords), type: 'position' });
        // Use ol.geom.Circle for accuracy (works in view projection units) — transform lonlat to map projection; provide radius in meters by approximating with ol.Sphere if desired.
        // Simpler: create a circle geometry in map projection by using ol.geom.Circle
        userLocationAccuracyFeature = new ol.Feature({});
        try {
            const accuracyGeom = new ol.geom.Circle(coords, Number(accuracyMeters) || 0);
            userLocationAccuracyFeature.setGeometry(accuracyGeom);
            userLocationAccuracyFeature.set('type', 'accuracy');
        } catch (e) {
            try { userLocationAccuracyFeature.setGeometry(null); } catch (ee) {}
        }
        try { if (userLocationAccuracyFeature) src.addFeature(userLocationAccuracyFeature); } catch (e) {}
        try { if (userLocationFeature) src.addFeature(userLocationFeature); } catch (e) {}
        try {
            const view = map.getView();
            if (view) {
                try { view.animate({ center: coords, zoom: Math.max(view.getZoom() || 12, 15), duration: 500 }); } catch (e) { }
            }
        } catch (e) {}
    } catch (e) { console.warn('showUserLocation failed', e); }
}

function clearUserLocation() {
    try {
        if (!userLocationLayer) return;
        const src = userLocationLayer.getSource();
        if (src && typeof src.clear === 'function') src.clear();
        userLocationFeature = null; userLocationAccuracyFeature = null;
    } catch (e) { console.warn('clearUserLocation failed', e); }
}

function setupGeolocateControl() {
    try {
        if (setupGeolocateControl._initialized) return;
        setupGeolocateControl._initialized = true;
        if (document.getElementById('geolocate-btn')) return;

        const btn = document.createElement('button');
        btn.id = 'geolocate-btn';
        btn.type = 'button';
        btn.textContent = '📍 Lokasi Anda';
        btn.style.background = '#007bff';
        btn.style.color = '#fff';
        btn.style.border = 'none';
        btn.style.padding = '10px 14px';
        btn.style.borderRadius = '6px';
        btn.style.cursor = 'pointer';
        btn.style.fontSize = '13px';
        btn.style.whiteSpace = 'nowrap';
        btn.style.height = 'auto';
        btn.style.width = 'auto';
        btn.style.lineHeight = 'normal';
        btn.addEventListener('click', function() {
            try {
                if (!('geolocation' in navigator)) { alert('Perangkat tidak mendukung Geolocation'); return; }
                btn.disabled = true; btn.textContent = '📡 Mencari...';
                navigator.geolocation.getCurrentPosition(function(pos) {
                    try {
                        const lat = pos.coords.latitude;
                        const lon = pos.coords.longitude;
                        const acc = pos.coords.accuracy || 0;
                        showUserLocation(lat, lon, acc);
                    } catch (e) { console.warn('geolocation success handler failed', e); }
                    btn.disabled = false; btn.textContent = '📍 Lokasi Anda';
                }, function(err) {
                    console.warn('geolocation error', err);
                    alert('Gagal mendapatkan lokasi: ' + (err && err.message ? err.message : 'Unknown'));
                    btn.disabled = false; btn.textContent = '📍 Lokasi Anda';
                }, { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 });
            } catch (e) { console.warn('geolocate click handler failed', e); btn.disabled = false; btn.textContent = '📍 Lokasi Anda'; }
        });

        // Create an OL control element so it sits inside the map's control area (bottom-right)
        const wrapper = document.createElement('div');
        wrapper.id = 'geolocate-wrapper';
        wrapper.className = 'geolocate-control';
        wrapper.style.cssText = 'position:absolute; bottom:40px; right:8px; z-index:100; background:rgba(255,255,255,0.7); border-radius:6px; padding:2px;';
        wrapper.appendChild(btn);

        if (typeof map !== 'undefined' && map && typeof ol !== 'undefined' && ol.control) {
            map.addControl(new ol.control.Control({ element: wrapper }));
            console.log('setupGeolocateControl: added as OL control');
        } else {
            // fallback: append to body at bottom-right
            wrapper.style.position = 'fixed';
            wrapper.style.bottom = '16px';
            wrapper.style.right = '16px';
            document.body.appendChild(wrapper);
        }
        // Initially hide button only on mobile where dashboard covers the map
        try {
            const db = document.getElementById('dashboard');
            const isMobile = window.innerWidth <= 768;
            if (isMobile && db && window.getComputedStyle(db).display !== 'none') {
                wrapper.style.display = 'none';
            }
        } catch(e) {}
    } catch (e) { console.warn('setupGeolocateControl failed', e); }
}



function showPolygonPopup(feature) {
    try {
        const popup = document.getElementById('popup-content');
        if (!popup) return;
        // Try to compute interior coordinate for positioning
        let pos = getFeatureInteriorCoordinate(feature);
        if (!pos) {
            const geom = feature.getGeometry && feature.getGeometry();
            if (geom) {
                try {
                    const center = ol.extent.getCenter(geom.getExtent());
                    const maybe = maybeLonLat(center);
                    if (maybe) pos = { latitude: maybe.latitude, longitude: maybe.longitude };
                } catch (e) {}
            }
        }

        const ward = feature.get('Ward') || feature.get('WARD') || feature.get('ward') || '';
        const district = feature.get('District') || feature.get('DISTRICT') || feature.get('district') || '';
        const city = feature.get('City') || feature.get('CITY') || feature.get('city') || '';

        popup.innerHTML = `
            <div class="customer-popup">
                <table>
                    <tr><td>Ward</td><td>${escapeHtml(ward)}</td></tr>
                    <tr><td>District</td><td>${escapeHtml(district)}</td></tr>
                    <tr><td>City</td><td>${escapeHtml(city)}</td></tr>
                </table>
            </div>
        `;

        try {
            if (typeof container !== 'undefined') container.style.display = 'block';
            if (typeof overlayPopup !== 'undefined' && pos) {
                overlayPopup.setPosition(ol.proj.fromLonLat([pos.longitude, pos.latitude]));
            }
        } catch (e) { console.warn('showPolygonPopup overlay error', e); }
    } catch (e) { console.warn('showPolygonPopup error', e); }
}

function getEditedCustomers() {
    try {
        if (!Array.isArray(customers)) return [];
        return customers.filter(c => c && c.__edited === true);
    } catch (e) { console.warn('getEditedCustomers failed', e); return []; }
}

function exportEditedCustomersCSV(edited) {
    try {
        if (!Array.isArray(edited) || edited.length === 0) return null;
        const keysSet = new Set();
        edited.forEach(obj => { Object.keys(obj || {}).forEach(k => { if (k !== '__edited') keysSet.add(k); }); });
        const keys = Array.from(keysSet);
        const escapeCell = v => {
            if (v === null || v === undefined) return '';
            const s = String(v);
            const sEsc = s.replace(/"/g, '""');
            if (sEsc.includes(',') || sEsc.includes('"') || sEsc.includes('\n')) return '"' + sEsc + '"';
            return sEsc;
        };
        const header = keys.join(',');
        const rows = edited.map(obj => keys.map(k => escapeCell(obj[k])).join(',')).join('\n');
        return header + '\n' + rows;
    } catch (e) { console.warn('exportEditedCustomersCSV failed', e); return null; }
}

function downloadFile(filename, text) {
    try {
        const blob = new Blob([text], { type: 'text/csv;charset=utf-8;' });
        if (window.navigator && window.navigator.msSaveOrOpenBlob) { window.navigator.msSaveOrOpenBlob(blob, filename); return; }
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a'); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); setTimeout(() => { try { document.body.removeChild(a); } catch (e) {} URL.revokeObjectURL(url); }, 100);
    } catch (e) { console.warn('downloadFile failed', e); }
}

function setupSaveEditsCSVControl() { return; // disabled: CSV is saved automatically from popup edits

    try {
        if (setupSaveEditsCSVControl._initialized) return;
        setupSaveEditsCSVControl._initialized = true;
        if (document.getElementById('save-edits-csv-btn')) return;
        const btn = document.createElement('button');
        btn.id = 'save-edits-csv-btn';
        btn.type = 'button';
        btn.textContent = '💾 Save edits (CSV)';
        btn.style.position = 'fixed';
        btn.style.right = '16px';
        btn.style.bottom = '72px';
        btn.style.zIndex = '2147483647';
        btn.style.background = '#28a745';
        btn.style.color = '#fff';
        btn.style.border = 'none';
        btn.style.padding = '10px 14px';
        btn.style.borderRadius = '6px';
        btn.style.cursor = 'pointer';
        btn.addEventListener('click', function() {
            try {
                const edited = getEditedCustomers();
                if (!edited || edited.length === 0) { alert('Tidak ada perubahan yang perlu disimpan.'); return; }
                const csv = exportEditedCustomersCSV(edited);
                if (!csv) { alert('Gagal membuat CSV. Periksa console untuk detail.'); return; }
                const filename = 'edited_customers_' + (new Date()).toISOString().replace(/[:.]/g, '-') + '.csv';
                downloadFile(filename, csv);
            } catch (e) { console.warn('save edits dl handler failed', e); alert('Gagal melakukan download.'); }
        });
        document.body.appendChild(btn);
    } catch (e) { console.warn('setupSaveEditsCSVControl failed', e); }
}

function setupMapClick() {

    map.on('singleclick', function(event) {

        // Collect all features at the clicked pixel so we can prefer customer markers over polygons
        const hits = [];
        map.forEachFeatureAtPixel(event.pixel, function(feature, layer) {
            hits.push({ feature, layer });
        });

        if (!hits || hits.length === 0) return;


        // Prefer feature that has 'customer' property (markers)
        let chosen = null;
        for (const h of hits) {
            try { if (h.feature && h.feature.get && h.feature.get('customer')) { chosen = h.feature; break; } } catch(e){}
        }

        // If no customer found, prefer ward/district polygon features
        if (!chosen) {
            for (const h of hits) {
                try {
                    const f = h.feature;
                    if (!f || !f.get) continue;
                    const hasWard = f.get('Ward') || f.get('WARD') || f.get('ward');
                    const hasDistrict = f.get('District') || f.get('DISTRICT') || f.get('district');
                    if (hasWard || hasDistrict) { chosen = f; break; }
                } catch(e) {}
            }
        }

        // fallback to first hit
        if (!chosen) chosen = hits[0].feature;

        if (!chosen) return;

        // If chosen is a customer marker, show customer popup; otherwise show polygon info
        try {
            const customer = chosen.get && chosen.get('customer');
            if (customer) {
                showCustomerPopup(customer, chosen);
            } else {
                showPolygonPopup(chosen);
            }
        } catch (e) { console.warn('setupMapClick handler error', e); }

    });

}


/* =========================================================
   UNIQUE VALUES
   ========================================================= */

function uniqueValues(
    data,
    field
) {

    return [
        ...new Set(

            data
                .map(
                    item =>
normalize(
                            item[field]
                        )
                )
                .filter(Boolean)

        )
    ]
    .sort(
        (a, b) =>
            a.localeCompare(
                b,
                "id"
            )
    );

}


/* =========================================================
   FILL SELECT
   ========================================================= */

function fillSelect(
    id,
    values,
    firstText
) {

    const select =
        document.getElementById(id);

    if (!select)
        return;

    select.innerHTML =
        `<option value="">
            ${firstText}
        </option>`;

    values.forEach(value => {

        const option =
            document.createElement(
                "option"
            );

        option.value = value;

        option.textContent =
            value;

        select.appendChild(
            option
        );

    });

}


/* =========================================================
   FILTER OPTIONS
   ========================================================= */

function updateFilters() {

    const normalizeFilterValue = value => {
        const normalized = normalize(value || "").toLowerCase();
        if (normalized.startsWith("semua") || normalized.startsWith("all")) return "";
        return value || "";
    };

    const city =
        normalizeFilterValue(document.getElementById("filter-city")?.value || "");

    const selectedSite =
        normalizeFilterValue(document.getElementById("filter-site")?.value || "");

    const selectedPortStatus =
        normalizeFilterValue(document.getElementById("filter-port-status")?.value || "");

    // Daftar kota/kabupaten dari seluruh data
    const cityValues =
        uniqueValues(customers, "city");

    fillSelect(
        "filter-city",
        cityValues,
        "Semua Kota/Kabupaten"
    );

    if (
        city &&
        cityValues.includes(city)
    ) {
        document.getElementById(
            "filter-city"
        ).value = city;
    }

    // Daftar nama site (dibatasi kota bila dipilih)
    const siteData = city ? customers.filter(c => c.city === city) : customers;

    const siteValues =
        uniqueValues(siteData, "site");

    fillSelect(
        "filter-site",
        siteValues,
        "Semua Nama Site"
    );

    if (
        selectedSite &&
        siteValues.includes(selectedSite)
    ) {
        document.getElementById(
            "filter-site"
        ).value = selectedSite;
    }

    const portStatusSelect = document.getElementById("filter-port-status");
    if (portStatusSelect) {
        portStatusSelect.innerHTML = '<option value="">Semua Status Port</option>';
        PORT_STATUS_FILTER_KEYS.forEach(key => {
            const config = PORT_STATUS_CONFIG[key];
            const option = document.createElement("option");
            option.value = key;
            option.textContent = config.label;
            portStatusSelect.appendChild(option);
        });

        if (selectedPortStatus && PORT_STATUS_FILTER_KEYS.includes(selectedPortStatus)) {
            portStatusSelect.value = selectedPortStatus;
        }
    }

}

/* =========================================================
   APPLY FILTER
   ========================================================= */

function applyFilters() {

    const normalizeFilterValue = value => {
        const normalized = normalize(value || "").toLowerCase();
        if (normalized.startsWith("semua") || normalized.startsWith("all")) return "";
        return value || "";
    };

    const city =
        normalizeFilterValue(document.getElementById("filter-city")?.value || "");

    const site =
        normalizeFilterValue(document.getElementById("filter-site")?.value || "");

    const portStatus =
        normalizeFilterValue(document.getElementById("filter-port-status")?.value || "");

    const keyword =
        normalize(
            document.getElementById("search-label")?.value
        ).toLowerCase();


    const filtered = customers.filter(c => {
        const cPortStatus = getPortStatusKey(c);
        return (
            (!city || c.city === city)
            && (!site || c.site === site)
            && (!portStatus || cPortStatus === portStatus)
            && (!keyword
                || normalize(c.label).toLowerCase().includes(keyword)
                || normalize(c.id).toLowerCase().includes(keyword)
                || normalize(c.site).toLowerCase().includes(keyword))
        );
    });


    // Marker individual per baris; popup tampilkan info FAT per marker
    // Render every FAT record; each marker popup still shows only its clicked ID.
    drawCustomers(filtered, { expandGroups: true });

    updateSummary(filtered);

    updateChart(filtered);

}

/* =========================================================
   SUMMARY
   ========================================================= */

function updateSummary(data) {

    const total = document.getElementById("total-customer");
    const ward = document.getElementById("total-ward");

    // Total marker
    const totalCustomer = data.length;

    if (total) {
        total.innerHTML = `${totalCustomer}`;
    }

    if (ward) {
        ward.textContent = new Set(
            data
                .map(c => c.city)
                .filter(Boolean)
        ).size;
    }

}

/* =========================================================
   CHART TYPE FAT / PORT STATUS
   ========================================================= */

function updateChart(data) {
    const grouped = new Map();
    data.forEach(c => {
        const type = String(c.dataFatFull?.['Tipe FAT'] || 'Tidak diketahui')
            .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
            .replace(/\s+/g, ' ')
            .trim() || 'Tidak diketahui';
        if (!grouped.has(type)) grouped.set(type, { used: 0, idle: 0 });
        const item = grouped.get(type);
        item.used += Number(c.totalUsedVisual) || 0;
        item.idle += Number(c.totalIdleVisual) || 0;
    });

    const labels = [...grouped.keys()];
    const usedValues = labels.map(label => grouped.get(label).used);
    const idleValues = labels.map(label => grouped.get(label).idle);


    const canvas =
        document.getElementById(
            "ward-chart"
        );

    if (!canvas || typeof Chart !== "function")
        return;

    if (wardChart)
        wardChart.destroy();

    wardChart = new Chart(
            canvas,
            {

                type: "bar",

                data: {
                    labels,
                    datasets: [
                        {
                            label: 'Total Used (Visual)',
                            data: usedValues,
                            backgroundColor: '#ef4444'
                        },
                        {
                            label: 'Total Idle (Visual)',
                            data: idleValues,
                            backgroundColor: '#22c55e'
                        }
                    ]
                },

                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    layout: {
                        padding: { top: 8, right: 8, bottom: 12, left: 8 }
                    },
                    scales: {
                        x: {
                            title: {
                                display: true,
                                text: 'Tipe FAT',
                                color: '#111827',
                                font: { weight: 'bold' }
                            },
                            ticks: {
                                autoSkip: false,
                                maxRotation: 0,
                                minRotation: 0,
                                callback: function(value) {
                                    const label = this.getLabelForValue(value);
                                    return String(label).split(' ');
                                }
                            }
                        },
                        y: { beginAtZero: true, title: { display: true, text: 'Jumlah Port' } }
                    },
                    plugins: {
                        legend: {
                            position:
                                "bottom"
                        }
                    }
                }
            }
        );

    const legend = document.getElementById('legend');
    if (legend) {
        legend.innerHTML = `
            <div class="legend-item"><span class="legend-color" style="background:#ef4444"></span><span>Total Used (Visual): ${usedValues.reduce((a, b) => a + b, 0)}</span></div>
            <div class="legend-item"><span class="legend-color" style="background:#22c55e"></span><span>Total Idle (Visual): ${idleValues.reduce((a, b) => a + b, 0)}</span></div>
        `;
    }

}


/* =========================================================
   LEGEND
   ========================================================= */

function updateLegend(count) {

    const legend =
        document.getElementById(
            "legend"
        );

    if (!legend)
        return;

    legend.innerHTML = "";


    Object.keys(
        STATUS_CONFIG
    ).forEach(key => {

        const config =
            STATUS_CONFIG[key];

        const item =
            document.createElement(
                "div"
            );

        item.className =
            "legend-item";


        item.innerHTML = `

            <span
                class="legend-color"
                style="
                    background:${config.color}
                "
            ></span>

            <span>
                ${config.label}
                :
                ${count[key] || 0}
            </span>

        `;


        legend.appendChild(
            item
        );

    });

}


/* =========================================================
   EVENTS
   ========================================================= */

function setupFilters() {
 
if (setupFilters._isInitialized) return;
setupFilters._isInitialized = true;
 
const search = document.getElementById("search-label");
 
if (search) {
    search.addEventListener("input", function () {
        applyFilters();
    });
}
 
    const city =
        document.getElementById(
            "filter-city"
        );

    const site =
        document.getElementById(
            "filter-site"
        );

    const portStatus =
        document.getElementById(
            "filter-port-status"
        );

    if (city) {

        city.addEventListener(
            "change",
            function() {

                updateFilters();
                applyFilters();

            }
        );

    }

    if (site) {

        site.addEventListener(
            "change",
            applyFilters
        );

    }

    if (portStatus) {
        portStatus.addEventListener(
            "change",
            applyFilters
        );
    }

}

function downloadTextFile(filename, contents) {
    try {
        const blob = new Blob([contents], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        }, 100);
    } catch (e) {
        console.warn('downloadTextFile failed', e);
    }
}

function normalizeCsvHeader(line) {
    return String(line ?? '')
        .replace(/^\uFEFF/, '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}

function mergeCsvContents(existingText, incomingText) {
    const existingLines = String(existingText ?? '')
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(line => line !== '');
    const incomingLines = String(incomingText ?? '')
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(line => line !== '');

    if (incomingLines.length === 0) return existingLines.join('\n');
    if (existingLines.length === 0) return incomingLines.join('\n');

    const existingHeader = normalizeCsvHeader(existingLines[0]);
    const incomingHeader = normalizeCsvHeader(incomingLines[0]);
    const startIndex = (existingHeader && incomingHeader && existingHeader === incomingHeader) ? 1 : 0;
    const appendedLines = incomingLines.slice(startIndex);
    return existingLines.concat(appendedLines).join('\n');
}

function getGitHubRepoFromHost() {
    const host = String(window.location.hostname || '').toLowerCase();
    if (!host.endsWith('.github.io')) return null;
    const owner = host.split('.')[0];
    if (!owner) return null;
    return { owner, repo: `${owner}.github.io` };
}

function getGitHubRepoInfo() {
    const repoInfo = getGitHubRepoFromHost();
    if (repoInfo) return repoInfo;
    const input = prompt('Masukkan GitHub owner/repo untuk menyimpan data/customer.csv (contoh: owner/repo):');
    if (!input) return null;
    const parts = input.split('/').map(part => part.trim());
    if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
    return { owner: parts[0], repo: parts[1] };
}

function getGitHubToken() {
    const storageKey = 'customerMapGitHubToken';
    let token = localStorage.getItem(storageKey);
    if (token) return token;
    token = prompt('Masukkan GitHub Personal Access Token dengan akses repo (untuk menyimpan data/customer.csv):');
    if (!token) return null;
    token = String(token).trim();
    if (token) {
        localStorage.setItem(storageKey, token);
        return token;
    }
    return null;
}

function base64EncodeUnicode(str) {
    try {
        return btoa(unescape(encodeURIComponent(str)));
    } catch (e) {
        return btoa(str);
    }
}

function base64DecodeUnicode(str) {
    try {
        return decodeURIComponent(escape(atob(str)));
    } catch (e) {
        return atob(str);
    }
}

async function saveCsvTextToGitHub(csvText, options = {}) {
    const repoInfo = getGitHubRepoInfo();
    if (!repoInfo) {
        throw new Error('Tidak ada informasi repository GitHub.');
    }
    const token = getGitHubToken();
    if (!token) {
        throw new Error('Token GitHub diperlukan untuk menyimpan ke repository.');
    }
    const { owner, repo } = repoInfo;
    const repoResponse = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
        headers: {
            Authorization: `token ${token}`,
            Accept: 'application/vnd.github+json'
        }
    });
    if (!repoResponse.ok) {
        const body = await repoResponse.text();
        throw new Error('Gagal membaca repo GitHub: ' + repoResponse.status + ' ' + repoResponse.statusText + ' - ' + body);
    }
    const repoData = await repoResponse.json();
    const branch = repoData.default_branch || 'main';
    const path = 'data/customer.csv';
    const encodedPath = path.split('/').map(encodeURIComponent).join('/');

    let existingText = '';
    let sha = null;
    const fileResponse = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${encodedPath}?ref=${encodeURIComponent(branch)}`, {
        headers: {
            Authorization: `token ${token}`,
            Accept: 'application/vnd.github+json'
        }
    });
    if (fileResponse.ok) {
        const fileData = await fileResponse.json();
        sha = fileData.sha;
        if (fileData.content) {
            existingText = base64DecodeUnicode(fileData.content.replace(/\n/g, ''));
        }
    } else if (fileResponse.status !== 404) {
        const body = await fileResponse.text();
        throw new Error('Gagal membaca file di repo: ' + fileResponse.status + ' ' + fileResponse.statusText + ' - ' + body);
    }

    const mergedText = (sha !== null) ? mergeCsvContents(existingText, csvText) : csvText;
    const commitMessage = options.commitMessage || (sha !== null ? 'Append uploaded customer CSV to data/customer.csv' : 'Create data/customer.csv from uploaded CSV');
    const putResponse = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${encodedPath}`, {
        method: 'PUT',
        headers: {
            Authorization: `token ${token}`,
            Accept: 'application/vnd.github+json',
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            message: commitMessage,
            content: base64EncodeUnicode(mergedText),
            branch,
            sha: sha || undefined
        })
    });
    if (!putResponse.ok) {
        const body = await putResponse.text();
        throw new Error('Gagal menyimpan file ke GitHub: ' + putResponse.status + ' ' + putResponse.statusText + ' - ' + body);
    }
    return { status: 'github', message: 'CSV berhasil ditambahkan ke GitHub repository.' };
}

async function saveCsvTextToServerOrDownload(csvText, options = {}) {
    const append = Boolean(options.append);
    const serverUrl = 'save_customer_csv.php' + (append ? '?append=1' : '');
    try {
        const response = await fetch(serverUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain' },
            body: csvText
        });

        if (!response.ok) {
            const text = await response.text();
            throw new Error('Server responded ' + response.status + ' ' + response.statusText + ': ' + text);
        }

        const body = await response.text();
        if (String(body || '').trim() !== 'OK') {
            throw new Error(String(body));
        }

        return { status: 'server', message: append ? 'CSV diunggah dan ditambahkan ke data/customer.csv' : 'CSV diunggah ke data/customer.csv' };
    } catch (error) {
        console.warn('saveCsvTextToServerOrDownload server save failed', error);
        // Skip GitHub — langsung download file sebagai fallback
        if (append) {
            try {
                const existingResponse = await fetch(DATA_URL + '?v=' + Date.now());
                if (!existingResponse.ok) {
                    throw new Error('Fetch existing DATA_URL failed: ' + existingResponse.status + ' ' + existingResponse.statusText);
                }
                const existingText = await existingResponse.text();
                const merged = mergeCsvContents(existingText, csvText);
                downloadTextFile('customer.csv', merged);
                return { status: 'download', message: 'Server tidak tersedia, file gabungan diunduh ke komputer Anda.' };
            } catch (fallbackError) {
                console.warn('saveCsvTextToServerOrDownload download fallback failed', fallbackError);
                downloadTextFile('customer.csv', csvText);
                return { status: 'download', message: 'Server tidak tersedia, CSV diunduh sebagai cadangan.' };
            }
        }

        downloadTextFile('customer.csv', csvText);
        return { status: 'download', message: 'Server tidak tersedia, CSV diunduh sebagai cadangan.' };
    }
}

/* =========================================================
   DASHBOARD BUTTON
   ========================================================= */

function setupDashboard() {
 
    const dashboard =
        document.getElementById(
            "dashboard"
        );
 
    const close =
        document.getElementById(
            "dashboard-close"
        );
 
    const toggle =
        document.getElementById(
            "dashboard-toggle"
        );
 
    const viewAllButton =
        document.getElementById(
            "view-all-data-button"
        );
 
 
    // Helper: toggle geolocate button visibility based on dashboard state
    // On desktop (dashboard is a side panel), always show the button.
    // On mobile (dashboard covers the full map), hide when dashboard is open.
    const syncGeolocateVisibility = () => {
        try {
            const gw = document.getElementById('geolocate-wrapper');
            if (!gw) return;
            const isMobile = window.innerWidth <= 768;
            if (!isMobile) {
                // Desktop: map always visible behind dashboard, always show button
                gw.style.display = '';
                return;
            }
            // Mobile: hide when dashboard covers the map
            const isOpen = dashboard && window.getComputedStyle(dashboard).display !== 'none';
            gw.style.display = isOpen ? 'none' : '';
        } catch(e) {}
    };
 
    if (close) {
 
        close.onclick =
            function() {
 
                dashboard.style.display =
                    "none";
 
                toggle.style.display =
                    "block";
 
                syncGeolocateVisibility();
 
            };
 
    }
 
 
    if (toggle) {
 
        toggle.onclick =
            function() {
 
                dashboard.style.display =
                    "block";
 
                toggle.style.display =
                    "none";
 
                syncGeolocateVisibility();
 
            };
 
    }
 
    if (viewAllButton) {
        viewAllButton.addEventListener('click', function() {
            openDataView();
        });
    }
 
}
 
let dataViewCurrentPage = 1;
const DATA_VIEW_PAGE_SIZE = 100;
 
function escapeHtml(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}
 
function matchesDataViewSearch(item, query) {
    if (!query) return true;
    const q = query.toLowerCase();
    return [
        item.label || item.username,
        item.id,
        item.site,
        item.ket || item.status,
        item.city,
        item.district,
        item.ward,
        item.visitDate,
        item.latitude,
        item.longitude
    ].some(value => String(value ?? '').toLowerCase().includes(q)) ||
        Object.values(item.dataFatFull || {}).some(value =>
            String(value ?? '').toLowerCase().includes(q)
        );
}
 
function compareVisitDateDesc(a, b) {
    const pa = parseVisitDate(a.visitDate);
    const pb = parseVisitDate(b.visitDate);
    if (pa && pb) {
        const da = `${pa.year}-${pa.month}-${pa.day}`;
        const db = `${pb.year}-${pb.month}-${pb.day}`;
        if (da < db) return 1;
        if (da > db) return -1;
        return 0;
    }
    if (pa && !pb) return -1;
    if (!pa && pb) return 1;
    return String(b.visitDate || '').localeCompare(String(a.visitDate || ''), 'id', { numeric: true, sensitivity: 'base' });
}

function renderDataView(page = 1) {
    const overlay = document.getElementById('data-view-overlay');
    const tbody = document.getElementById('data-view-tbody');
    const pageInfo = document.getElementById('data-view-page-info');
    const countLabel = document.getElementById('data-view-count');
    const searchInput = document.getElementById('data-view-search');
    const tableHead = document.querySelector('#data-view-table thead');
    if (!overlay || !tbody || !pageInfo || !countLabel || !searchInput) return;
 
    const query = String(searchInput.value || '').trim();
    let data = Array.isArray(customers) ? customers : [];
    if (query) {
        data = data.filter(item => matchesDataViewSearch(item, query));
    }
    data = data.slice().sort(compareVisitDateDesc);
 
    const total = data.length;
    const totalPages = Math.max(1, Math.ceil(total / DATA_VIEW_PAGE_SIZE));
    dataViewCurrentPage = Math.min(Math.max(1, page), totalPages);
 
    const headers = [...new Set(data.flatMap(item =>
        Object.keys(item.dataFatFull || {})
    ))];
    if (tableHead) {
        tableHead.innerHTML = `<tr>${headers.map(header =>
            `<th style="padding:10px; border-bottom:1px solid #ddd; text-align:left; white-space:nowrap;">${escapeHtml(header)}</th>`
        ).join('')}</tr>`;
    }
    tbody.innerHTML = "";
 
    const start = total === 0 ? 0 : (dataViewCurrentPage - 1) * DATA_VIEW_PAGE_SIZE;
    const end = Math.min(total, start + DATA_VIEW_PAGE_SIZE);
 
    for (let i = start; i < end; i++) {
        const item = data[i];
        const raw = item.dataFatFull || {};
        const row = document.createElement('tr');
        row.innerHTML = headers.map(header =>
            `<td style="padding:8px; border-bottom:1px solid #ddd; white-space:nowrap;">${escapeHtml(raw[header] ?? '')}</td>`
        ).join('');
        tbody.appendChild(row);
    }
 
    pageInfo.textContent = total === 0
        ? 'Tidak ada data yang cocok.'
        : `Menampilkan ${start + 1}-${end} dari ${total} baris`;
    countLabel.textContent = `Total data saat ini: ${total}`;
 
    const prev = document.getElementById('data-view-prev');
    const next = document.getElementById('data-view-next');
    if (prev) prev.disabled = dataViewCurrentPage <= 1;
    if (next) next.disabled = dataViewCurrentPage >= totalPages;
  
}
 
function openDataView() {
    const overlay = document.getElementById('data-view-overlay');
    if (!overlay) return;
    overlay.style.display = 'block';
    // hide geolocate button while data view overlay is visible
    try { const gw = document.getElementById('geolocate-wrapper'); if (gw) gw.style.display = 'none'; } catch (e) {}
    // ensure pagination controls are visible when overlay opens
    try { const prev = document.getElementById('data-view-prev'); if (prev) prev.style.display = ''; } catch(e) {}
    try { const next = document.getElementById('data-view-next'); if (next) next.style.display = ''; } catch(e) {}
    dataViewCurrentPage = 1;
    renderDataView(dataViewCurrentPage);
}
 
function closeDataView() {
    const overlay = document.getElementById('data-view-overlay');
    if (!overlay) return;
    overlay.style.display = 'none';
    // restore geolocate button visibility when overlay is closed
    try {
        const gw = document.getElementById('geolocate-wrapper');
        if (gw) {
            const isMobile = window.innerWidth <= 768;
            if (!isMobile) {
                gw.style.display = ''; // Desktop: always show
            } else {
                const dash = document.getElementById('dashboard');
                const dashOpen = dash && window.getComputedStyle(dash).display !== 'none';
                gw.style.display = dashOpen ? 'none' : '';
            }
        }
    } catch (e) {}
}
 
function setupDataView() {
    const overlay = document.getElementById('data-view-overlay');
    const closeBtn = document.getElementById('data-view-close');
    const prev = document.getElementById('data-view-prev');
    const next = document.getElementById('data-view-next');
    if (!overlay || setupDataView._initialized) return;
    setupDataView._initialized = true;
 
    if (closeBtn) {
        closeBtn.addEventListener('click', closeDataView);
    }
    if (prev) {
        prev.addEventListener('click', function() {
            if (dataViewCurrentPage > 1) {
                renderDataView(dataViewCurrentPage - 1);
            }
        });
    }
    if (next) {
        next.addEventListener('click', function() {
            renderDataView(dataViewCurrentPage + 1);
        });
    }
   const searchInput = document.getElementById('data-view-search');
   if (searchInput) {
       searchInput.addEventListener('input', function() {
           renderDataView(1);
       });
   }

   // MutationObserver: hide geolocate-like floating buttons whenever data view overlay is shown
   try {
       const hideCandidates = (hide) => {
           try {
               // Strategy: hide known controls (by id/class/text) AND any small fixed-position floating element
               const known = Array.from(document.querySelectorAll('button, a, [role="button"]'));
               const candidates = new Set(known);

               // Add any element that is fixed-position, small, and located near bottom-right
               const all = Array.from(document.querySelectorAll('body *'));
               for (const el of all) {
                   try {
                       const cs = window.getComputedStyle(el);
                       if (!cs) continue;
                       if (cs.position === 'fixed') {
                           const w = el.offsetWidth || el.getBoundingClientRect().width || 0;
                           const h = el.offsetHeight || el.getBoundingClientRect().height || 0;
                           if (w > 6 && w < 120 && h > 6 && h < 120) {
                               const rect = el.getBoundingClientRect();
                               const nearBottom = (rect.bottom >= (window.innerHeight - 120));
                               const nearRight = (rect.right >= (window.innerWidth - 120));
                               if (nearBottom && nearRight) candidates.add(el);
                           }
                       }
                   } catch (e) {}
               }

               for (const el of candidates) {
                   try {
                       // Never hide pagination controls inside the data view
                       const lid = (el.id || '').toString();
                       if (lid === 'data-view-prev' || lid === 'data-view-next' || lid === 'data-view-close') continue;

                       const txt = (el.textContent || '').trim();
                       const id = (el.id || '').toString().toLowerCase();
                       const cls = (el.className || '').toString().toLowerCase();
                       const looksLikeGeo = txt.includes('📍') || id.includes('geolocate') || id.includes('geolocate-btn') || id.includes('marker-edit') || id.includes('save-edits') || cls.includes('marker-edit') || cls.includes('geolocate');
                       if (!looksLikeGeo) {
                           // also allow hiding by spatial location (small fixed near bottom-right)
                           const cs = window.getComputedStyle(el);
                           const rect = el.getBoundingClientRect();
                           const small = (rect.width > 6 && rect.width < 120 && rect.height > 6 && rect.height < 120);
                           const nearBR = rect.bottom >= (window.innerHeight - 120) && rect.right >= (window.innerWidth - 120);
                           if (!(small && nearBR)) continue;
                       }

                       if (hide) {
                           if (!el.dataset._prevDisplay) el.dataset._prevDisplay = window.getComputedStyle(el).display || '';
                           el.style.display = 'none';
                       } else {
                           try { el.style.display = el.dataset._prevDisplay || ''; } catch (e) { el.style.display = ''; }
                           try { delete el.dataset._prevDisplay; } catch (e) {}
                       }
                   } catch (e) {}
               }
           } catch (e) {}
       };

       const sync = () => {
           try {
               const cs = window.getComputedStyle(overlay);
               const rects = overlay.getClientRects ? overlay.getClientRects() : [];
               const visible = (cs.display !== 'none') && (cs.visibility !== 'hidden') && (rects && rects.length > 0) && (parseFloat(cs.opacity || '1') > 0.01);
               hideCandidates(visible);
           } catch (e) {}
       };

       // initial sync
       sync();
       const mo = new MutationObserver(function(mutations) {
           for (const m of mutations) {
               if (m.type === 'attributes' && m.attributeName === 'style') {
                   sync();
               }
           }
       });
       mo.observe(overlay, { attributes: true, attributeFilter: ['style'] });

       // also listen for clicks that may open overlay via other controls
       document.addEventListener('click', function() { setTimeout(sync, 50); }, true);
   } catch (e) { console.warn('setupDataView observer failed', e); }
}
 
/* =========================================================
   ROBUST CSV LOADER
   Attempts fetch(), falls back to XMLHttpRequest, and
   detects file:// usage so the user gets a helpful message.
   ========================================================= */

function isFileProtocol() {
    return typeof window !== 'undefined' && window.location &&
        window.location.protocol === 'file:';
}

function loadCsvTextWithXhr(url) {
    return new Promise(function(resolve, reject) {
        try {
            const xhr = new XMLHttpRequest();
            xhr.open('GET', url, true);
            xhr.responseType = 'text';
            xhr.onreadystatechange = function() {
                if (xhr.readyState !== 4) return;
                if (xhr.status >= 200 && xhr.status < 300) {
                    resolve(xhr.responseText);
                } else {
                    reject(new Error('CSV gagal dibaca (XHR). HTTP ' + xhr.status + ' ' + xhr.statusText));
                }
            };
            xhr.onerror = function() {
                reject(new Error('CSV gagal dibaca (XHR network error).'));
            };
            xhr.send();
        } catch (e) {
            reject(e);
        }
    });
}

async function loadCsvText(url) {
    // Clear, actionable guidance when opened directly from disk (file://)
    if (isFileProtocol()) {
        const msg =
            'File CSV tidak dapat dimuat karena halaman dibuka langsung dari file (file://).\n\n' +
            'Browser memblokir fetch file lokal demi keamanan.\n\n' +
            'Solusi:\n' +
            '1. Jalankan lewat server lokal (contoh: http://localhost/qgis/index.html via XAMPP), ATAU\n' +
            '2. Deploy ke hosting gratis (Azure Static Web Apps) lalu buka lewat https.';
        console.error('[CUSTOMER_MAP] file:// protocol detected. ' + msg);
        throw new Error(msg);
    }

    let lastError = null;
    try {
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error('CSV gagal dibaca. HTTP ' + response.status);
        }
        return await response.text();
    } catch (fetchError) {
        lastError = fetchError;
        console.warn('[CUSTOMER_MAP] fetch failed, trying XHR fallback', fetchError);
        try {
            return await loadCsvTextWithXhr(url);
        } catch (xhrError) {
            console.warn('[CUSTOMER_MAP] XHR fallback also failed', xhrError);
            throw lastError;
        }
    }
}

/* =========================================================
   XLSX / ROWS HELPERS (Data FAT Full)
   ========================================================= */

async function loadXlsxArrayBuffer(url) {
    if (isFileProtocol()) {
        const msg =
            'File data tidak dapat dimuat karena halaman dibuka langsung dari file (file://).\n\n' +
            'Browser memblokir fetch file lokal demi keamanan.\n\n' +
            'Solusi:\n' +
            '1. Jalankan lewat server lokal (contoh: http://localhost/qgis/index.html via XAMPP), ATAU\n' +
            '2. Deploy ke hosting (Azure Static Web Apps / GitHub Pages) lalu buka lewat https.';
        console.error('[CUSTOMER_MAP] file:// protocol detected. ' + msg);
        throw new Error(msg);
    }
    let lastError = null;
    try {
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error('Data gagal dibaca. HTTP ' + response.status);
        }
        return await response.arrayBuffer();
    } catch (fetchError) {
        lastError = fetchError;
        console.warn('[CUSTOMER_MAP] fetch failed, trying XHR fallback', fetchError);
        try {
            return await new Promise(function (resolve, reject) {
                const xhr = new XMLHttpRequest();
                xhr.open('GET', url, true);
                xhr.responseType = 'arraybuffer';
                xhr.onreadystatechange = function () {
                    if (xhr.readyState !== 4) return;
                    if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.response);
                    else reject(new Error('Data gagal dibaca (XHR). HTTP ' + xhr.status + ' ' + xhr.statusText));
                };
                xhr.onerror = function () {
                    reject(new Error('Data gagal dibaca (XHR network error).'));
                };
                xhr.send();
            });
        } catch (xhrError) {
            console.warn('[CUSTOMER_MAP] XHR fallback also failed', xhrError);
            throw lastError;
        }
    }
}

// Baca buffer XLSX -> array row objects (pakai XLSXLite dari resources/xlsx-lite.js)
async function xlsxRowsFromBuffer(buf) {
    if (typeof XLSXLite !== 'undefined' && XLSXLite && typeof XLSXLite.read === 'function') {
        const wb = await XLSXLite.read(buf);
        const name = (wb.sheetNames && wb.sheetNames[0]) || null;
        const rows = name ? wb.sheets[name] : null;
        if (!rows) throw new Error('XLSX tidak berisi sheet apa pun.');
        console.log('[CUSTOMER_MAP] XLSX sheets:', wb.sheetNames.join(', '), '-> memakai sheet "' + name + '" rows=', rows.length);
        return XLSXLite.sheetToObjects(rows);
    }
    throw new Error('Parser XLSX (resources/xlsx-lite.js) tidak termuat.');
}

// Serialisasi ulang row objects -> teks CSV ';' agar kompatibel dengan alur parsing/filtering yang ada
function rowsToCsvText(rows) {
    if (!Array.isArray(rows) || rows.length === 0) return '';
    const headers = Object.keys(rows[0] || {});
    const esc = v => String(v ?? '').replace(/[\r\n]+/g, ' ').replace(/;/g, ',');
    const lines = [headers.map(h => esc(h)).join(';')];
    for (const r of rows) {
        lines.push(headers.map(h => esc(r[h])).join(';'));
    }
    return lines.join('\n');
}

/* =========================================================
   LOAD DATA (XLSX)
   ========================================================= */

async function loadData(input = null) {
 
    try {
 
        // Ensure polygon layers are ready so ward index is accurate
        await waitForLayersReady(5000, 5);
        try { buildWardIndex(); } catch(e){ console.warn('buildWardIndex failed (pre-fetch)', e); }
        try { buildWardPolygonIndex(); } catch(e){ console.warn('buildWardPolygonIndex failed (pre-fetch)', e); }
 
        // Remove any stale customer layers before loading fresh data
        try { removeStaleCustomerLayers(); } catch(e) { }
 
        // Sumber data: data/Data FAT Full.xlsx (default), atau upload CSV/XLSX, atau array rows
        let rows;
        if (input === null) {
            const buf = await loadXlsxArrayBuffer(DATA_URL + "?v=" + Date.now());
            rows = await xlsxRowsFromBuffer(buf);
        } else if (Array.isArray(input)) {
            rows = input;
        } else if (typeof ArrayBuffer !== 'undefined' && input instanceof ArrayBuffer) {
            rows = await xlsxRowsFromBuffer(input);
        } else {
            rows = parseCSV(String(input));
        }
        const text = rowsToCsvText(rows);
 
        console.log('[CUSTOMER_MAP] loadData start, rows=', rows.length);
        // Faster initial render: show a small immediate subset while full CSV is parsed in the background
        const t0 = performance.now();

        // Parse seluruh rows secara chunked (tanpa preview; dataset XLSX sudah cepat diparse)
        customers = await parseCustomerDataAsync(rows, { chunkSize: 1000 });
        const t1 = performance.now();
        console.log('[CUSTOMER_MAP] loadData parsed customers count=', customers.length, 'parseMs=', Math.round(t1 - t0));

        if (customers.length === 0) {
            console.warn('[CUSTOMER_MAP] loadData: tidak ada baris valid diparse, mencoba fallback parse');
            customers = fallbackParseCustomerRows(rows);
            console.log('[CUSTOMER_MAP] loadData fallback customers count=', customers.length);
        }

        try { updateFilters(); } catch (e) { }

        setupFilters();
        setupDashboard();
        setupDataView();
        setupMapClick();
        createCustomerLayer();
        drawCustomers(customers, { expandGroups: true });
        updateSummary(customers);
        updateChart(customers);

    }
catch (error) {

    console.error(error);

    alert(
        "ERROR\n\n" +
        error.name + "\n\n" +
        error.message
    );

}


}

/* =========================================================
   SHIM WEB WORKER PARSE (opsional; pakai parser utama)
   ========================================================= */

function parseCustomerDataWithWorker(text, wardIndexEntries, options = {}) {
    // Worker khusus CSV lama tidak dipakai lagi; gunakan parser utama agar mapping header konsisten
    return parseCustomerDataAsync(text, { chunkSize: (options && options.chunkSize) || 1000 });
}

/* =========================================================
   START
   ========================================================= */

async function waitForLayersReady(timeout = 3000, interval = 5) {
    const layers = [];
    if (typeof lyr_surabaya_2 !== 'undefined') layers.push(lyr_surabaya_2);
    if (typeof lyr_SIDOARJO_1 !== 'undefined') layers.push(lyr_SIDOARJO_1);
    if (typeof lyr_Denpasar_1 !== 'undefined') layers.push(lyr_Denpasar_1);
    const start = Date.now();
    return new Promise(resolve => {
        const check = () => {
            try {
                const ready = layers.every(layer => !layer || !(layer.getSource && typeof layer.getSource().getFeatures === 'function') || layer.getSource().getFeatures().length > 0);
                if (ready || Date.now() - start > timeout) {
                    resolve();
                } else {
                    setTimeout(check, interval);
                }
            } catch (e) {
                resolve();
            }
        };
        check();
    });
}

async function startCustomerMap() {
    const start = Date.now();
    while (typeof map === "undefined" || !map) {
        if (Date.now() - start > 5000) {
            console.error("OpenLayers map belum tersedia setelah 5000ms.");
            return;
        }
        await new Promise(resolve => setTimeout(resolve, 5));
    }

    // Remove controls left by an older cached script version.
    document.querySelectorAll('#marker-edit-toggle, #marker-edit-floating, #popup-edit-controls').forEach(element => element.remove());
 
    // Wait a short while for polygon layers to populate features (helps ward lookup)
    await waitForLayersReady(3000, 5);
 
    try {
        buildWardIndex();
    } catch (e) {
        console.warn('buildWardIndex failed during start', e);
    }
    try {
        buildWardPolygonIndex();
    } catch (e) {
        console.warn('buildWardPolygonIndex failed during start', e);
    }
 
    // Geolocate control (device GPS)
    try { setupGeolocateControl(); } catch (e) { console.warn('setupGeolocateControl failed', e); }
    await loadData();
}

/*
 * Tunggu qgis2web selesai membuat map
 */

if (
    document.readyState ===
    "loading"
) {

    document.addEventListener(
        "DOMContentLoaded",
        function() {

            setTimeout(
                startCustomerMap,
                5
            );

        }
    );

}
else {

    setTimeout(
        startCustomerMap,
        5
    );

}
