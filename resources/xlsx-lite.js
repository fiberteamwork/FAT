/* =========================================================
   xlsx-lite.js — Parser XLSX mandiri (tanpa library eksternal)
   Mendukung: ZIP (stored & deflate via DecompressionStream),
   sharedStrings.xml, inline strings, dan konversi tanggal serial Excel.
   API:
     XLSXLite.read(arrayBuffer) -> Promise<{ sheets: { name: rows[][] }, sheetNames: [] }>
     XLSXLite.sheetToObjects(rows) -> [ { "Header": value, ... } ]
   ========================================================= */
(function (global) {
    'use strict';

    /* ---------------- ZIP reader ---------------- */

    // Decode raw DEFLATE stream menggunakan CompressionStream bawaan browser (Chrome 80+)
    function inflateRaw(u8) {
        return new Promise(function (resolve, reject) {
            try {
                if (typeof DecompressionStream === 'undefined') {
                    reject(new Error('DecompressionStream tidak didukung browser ini.'));
                    return;
                }
                // DecompressionStream('deflate-raw') tersedia Chrome 103+, Firefox 113+, Safari 16.4+
                var format = 'deflate-raw';
                var ds;
                try {
                    ds = new DecompressionStream(format);
                } catch (e) {
                    reject(new Error('DecompressionStream("deflate-raw") tidak tersedia.'));
                    return;
                }
                var blob = new Blob([u8]);
                var stream = blob.stream().pipeThrough(ds);
                new Response(stream).arrayBuffer().then(function (buf) {
                    resolve(new Uint8Array(buf));
                }).catch(reject);
            } catch (e) {
                reject(e);
            }
        });
    }

    // Baca semua entry dari central directory ZIP
    function readZip(buf) {
        var u8 = new Uint8Array(buf);
        var dv = new DataView(buf);

        // Cari signature End Of Central Directory (0x06054b50) dari belakang
        var eocd = -1;
        var minEocd = Math.max(0, u8.length - 66000);
        for (var i = u8.length - 22; i >= minEocd; i--) {
            if (u8[i] === 0x50 && u8[i + 1] === 0x4b && u8[i + 2] === 0x05 && u8[i + 3] === 0x06) {
                eocd = i;
                break;
            }
        }
        if (eocd < 0) throw new Error('ZIP: End of Central Directory tidak ditemukan (bukan file .xlsx?)');

        var entryCount = dv.getUint16(eocd + 10, true);
        var cdOffset = dv.getUint32(eocd + 16, true);

        var entries = {};
        var p = cdOffset;
        for (var n = 0; n < entryCount; n++) {
            if (dv.getUint32(p, true) !== 0x02014b50) break; // central dir file header
            var method = dv.getUint16(p + 10, true);
            var compSize = dv.getUint32(p + 20, true);
            var nameLen = dv.getUint16(p + 28, true);
            var extraLen = dv.getUint16(p + 30, true);
            var commentLen = dv.getUint16(p + 32, true);
            var localOffset = dv.getUint32(p + 42, true);
            var name = '';
            for (var c = 0; c < nameLen; c++) name += String.fromCharCode(u8[p + 46 + c]);
            entries[name] = { method: method, compSize: compSize, localOffset: localOffset };
            p += 46 + nameLen + extraLen + commentLen;
        }
        return { u8: u8, dv: dv, entries: entries };
    }

    // Ambil isi (Uint8Array) dari satu entry ZIP, dekompresi bila perlu
    function zipEntryData(zip, name) {
        var entry = zip.entries[name];
        if (!entry) return null;
        var u8 = zip.u8;
        var off = entry.localOffset;
        var dv = zip.dv;
        if (dv.getUint32(off, true) !== 0x04034b50) throw new Error('ZIP: local header rusak untuk ' + name);
        var nameLen = dv.getUint16(off + 26, true);
        var extraLen = dv.getUint16(off + 28, true);
        var dataStart = off + 30 + nameLen + extraLen;
        var raw = u8.subarray(dataStart, dataStart + entry.compSize);
        if (entry.method === 0) return raw; // stored
        if (entry.method === 8) return inflateRaw(raw); // deflate
        throw new Error('ZIP: metode kompresi tidak didukung (' + entry.method + ')');
    }

    function u8ToText(u8) {
        try {
            return new TextDecoder('utf-8').decode(u8);
        } catch (e) {
            var s = '';
            for (var i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
            return decodeURIComponent(escape(s));
        }
    }

    /* ---------------- XML helpers ---------------- */

    // Expand prefix namespace (mis. "x:t" -> "t") lalu parse dengan DOMParser
    function parseXml(text) {
        var cleaned = text.replace(/<([a-zA-Z0-9_]+):/g, '<$1__NS__').replace(/<\/([a-zA-Z0-9_]+):/g, '</$1__NS__');
        var doc = new DOMParser().parseFromString(cleaned, 'text/xml');
        var err = doc.getElementsByTagName('parsererror');
        if (err && err.length) throw new Error('XML parse error: ' + (err[0].textContent || '').slice(0, 200));
        return doc;
    }

    function childElements(el, tagName) {
        var out = [];
        if (!el) return out;
        for (var i = 0; i < el.children.length; i++) {
            var c = el.children[i];
            // nodeName bisa 'sheet' (tanpa prefix) atau 'x__NS__sheet' (prefix di-expand oleh parseXml)
            if (c.nodeName === tagName || c.nodeName.indexOf('__NS__' + tagName, c.nodeName.length - tagName.length - 6) !== -1) out.push(c);
        }
        return out;
    }

    function firstChild(el, tagName) {
        var list = childElements(el, tagName);
        return list.length ? list[0] : null;
    }

    /* ---------------- Sheet value decode ---------------- */

    function columnNameToIndex(name) {
        var n = 0;
        for (var i = 0; i < name.length; i++) {
            n = n * 26 + (name.charCodeAt(i) - 64);
        }
        return n - 1; // A=0
    }

    function parseCellRef(ref) {
        var m = /^([A-Z]+)(\d+)$/.exec(String(ref || '').toUpperCase());
        if (!m) return null;
        return { col: columnNameToIndex(m[1]), row: parseInt(m[2], 10) - 1 };
    }

    // Konversi serial tanggal Excel (basis 1900) ke string dd/mm/yyyy bila cell berformat tanggal
    function excelSerialToDateString(serial) {
        var whole = Math.floor(serial);
        var frac = serial - whole;
        // Excel epoch: 1900-01-01 = serial 1; ada bug 1900 (serial 60 = 29 Feb 1900 fiktif)
        var days = whole - 25569; // 1970-01-01 = serial 25569
        var ms = days * 86400000 + Math.round(frac * 86400000);
        var d = new Date(ms);
        if (isNaN(d.getTime())) return null;
        var dd = String(d.getUTCDate()).padStart(2, '0');
        var mm = String(d.getUTCMonth() + 1).padStart(2, '0');
        var yyyy = d.getUTCFullYear();
        return dd + '/' + mm + '/' + yyyy;
    }

    function decodeCell(cEl, sharedStrings, stylesDateSet) {
        var ref = cEl.getAttribute('r');
        var t = cEl.getAttribute('t') || '';
        var s = cEl.getAttribute('s');
        var vEl = firstChild(cEl, 'v');
        var isEl = firstChild(cEl, 'is');
        var text = '';

        if (t === 's' && vEl) {
            var idx = parseInt(vEl.textContent, 10);
            text = sharedStrings[idx] !== undefined ? sharedStrings[idx] : '';
        } else if (t === 'inlineStr' && isEl) {
            var tNodes = isEl.getElementsByTagName('*');
            for (var i = 0; i < tNodes.length; i++) {
                var nn = tNodes[i].nodeName;
                if (nn === 't' || nn.indexOf('__NS__t', nn.length - 7) !== -1) {
                    text += tNodes[i].textContent;
                }
            }
        } else if (vEl) {
            text = vEl.textContent;
            // Jika cell berformat tanggal, konversi serial ke dd/mm/yyyy
            if (s !== null && stylesDateSet && stylesDateSet.has(parseInt(s, 10)) && text !== '' && isFinite(Number(text))) {
                var ds = excelSerialToDateString(Number(text));
                if (ds) text = ds;
            }
        }
        return { ref: ref, value: text };
    }

    // Kumpulkan style id yang berformat tanggal (numFmtId 14-22, 45-47, atau numFmt kustom berisi y/m/d)
    function buildDateStyleSet(stylesXml) {
        var set = new Set();
        if (!stylesXml) return set;
        try {
            var doc = parseXml(stylesXml);
            var numFmts = {};
            childElements(firstChild(doc.documentElement, 'numFmts'), 'numFmt').forEach(function (nf) {
                numFmts[parseInt(nf.getAttribute('numFmtId'), 10)] = String(nf.getAttribute('formatCode') || '');
            });
            var cellXfs = firstChild(doc.documentElement, 'cellXfs');
            childElements(cellXfs, 'xf').forEach(function (xf, i) {
                var id = parseInt(xf.getAttribute('numFmtId'), 10);
                if (!isFinite(id)) return;
                if ((id >= 14 && id <= 22) || (id >= 45 && id <= 47) || (id === 14)) {
                    set.add(i);
                } else if (numFmts[id]) {
                    var code = numFmts[id].toLowerCase();
                    if (code.indexOf('y') !== -1 || code.indexOf('d') !== -1) set.add(i);
                }
            });
        } catch (e) { /* styles opsional */ }
        return set;
    }

    /* ---------------- Workbook reader ---------------- */

    async function read(arrayBuffer) {
        var zip = readZip(arrayBuffer);

        // sharedStrings
        var sharedStrings = [];
        var ssData = await zipEntryData(zip, 'xl/sharedStrings.xml');
        if (ssData) {
            var ssDoc = parseXml(u8ToText(ssData));
            childElements(ssDoc.documentElement, 'si').forEach(function (si) {
                var text = '';
                // <si> bisa berisi <t> tunggal atau beberapa <r><t> (rich text)
                var rNodes = childElements(si, 'r');
                if (rNodes.length) {
                    rNodes.forEach(function (r) {
                        var tEl = firstChild(r, 't');
                        if (tEl) text += tEl.textContent;
                    });
                } else {
                    var tEl = firstChild(si, 't');
                    if (tEl) text = tEl.textContent;
                }
                sharedStrings.push(text);
            });
        }

        // styles (untuk deteksi kolom tanggal)
        var stylesData = await zipEntryData(zip, 'xl/styles.xml');
        var dateStyles = buildDateStyleSet(stylesData ? u8ToText(stylesData) : null);

        // workbook.xml -> daftar sheet + rel id
        var wbData = await zipEntryData(zip, 'xl/workbook.xml');
        if (!wbData) throw new Error('XLSX: xl/workbook.xml tidak ditemukan.');
        var wbDoc = parseXml(u8ToText(wbData));
        var sheetNodes = childElements(firstChild(wbDoc.documentElement, 'sheets'), 'sheet');

        // workbook.xml.rels -> rId -> target file
        var relsData = await zipEntryData(zip, 'xl/_rels/workbook.xml.rels');
        var relMap = {};
        if (relsData) {
            var relsDoc = parseXml(u8ToText(relsData));
            childElements(relsDoc.documentElement, 'Relationship').forEach(function (rel) {
                relMap[rel.getAttribute('Id')] = rel.getAttribute('Target');
            });
        }

        var sheetNames = [];
        var sheets = {};

        for (const sh of sheetNodes) {
            var name = sh.getAttribute('name') || ('Sheet' + (sheetNames.length + 1));
            var rid = sh.getAttribute('r:id') || sh.getAttribute('id');
            var target = relMap[rid] || '';
            var path = target.replace(/^\//, '');
            if (path.indexOf('xl/') !== 0) path = 'xl/' + path;

            var data = await zipEntryData(zip, path);
            if (!data) return;

            var doc = parseXml(u8ToText(data));
            var sheetDataEl = firstChild(doc.documentElement, 'sheetData');
            var rowsOut = [];

            childElements(sheetDataEl, 'row').forEach(function (rowEl) {
                var cells = [];
                childElements(rowEl, 'c').forEach(function (cEl) {
                    var cell = decodeCell(cEl, sharedStrings, dateStyles);
                    if (!cell.ref) return;
                    var pos = parseCellRef(cell.ref);
                    if (!pos) return;
                    cells[pos.col] = cell.value;
                });
                rowsOut.push(cells);
            });

            sheetNames.push(name);
            sheets[name] = rowsOut;
        }

        return { sheetNames: sheetNames, sheets: sheets };
    }

    /* ---------------- Rows -> objects ---------------- */

    function sheetToObjects(rows) {
        if (!Array.isArray(rows) || rows.length === 0) return [];
        var header = rows[0] || [];
        var out = [];
        for (var i = 1; i < rows.length; i++) {
            var row = rows[i];
            if (!row || row.length === 0) continue;
            var isEmpty = true;
            var obj = {};
            for (var c = 0; c < header.length; c++) {
                var key = String(header[c] === undefined || header[c] === null ? '' : header[c]).trim();
                var val = row[c] === undefined || row[c] === null ? '' : String(row[c]).trim();
                if (key === '') key = 'Kolom' + (c + 1);
                obj[key] = val;
                if (val !== '') isEmpty = false;
            }
            if (!isEmpty) out.push(obj);
        }
        return out;
    }

    global.XLSXLite = {
        read: read,
        sheetToObjects: sheetToObjects,
        excelSerialToDateString: excelSerialToDateString
    };

})(typeof window !== 'undefined' ? window : this);
