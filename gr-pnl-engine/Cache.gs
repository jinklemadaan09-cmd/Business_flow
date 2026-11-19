/**
 * CACHE.GS
 * --------
 * Engine storage lives as JSON files in a Drive folder (GR_DASHBOARD_DATA/GR_PNL_ENGINE_CACHE),
 * NOT as sheets. That removes the 10-million-cell pressure from this
 * spreadsheet and makes every write a single file save.
 *
 *   cache_<SRC>_<fileId>.json  processed records of ONE source file
 *   dashboard_master_part_N.json  the full joined master, split in parts (full load)
 *   delta_<version>.json       what changed in one refresh (for incremental loads)
 *   engine_state.json          manifest: which file is cached, versions, deltas
 *
 * Never edit these files by hand. "Full rebuild" recreates everything.
 */

var PROP_CACHE_FOLDER = 'ENGINE_CACHE_FOLDER_ID';
var PROP_STATE_FILE = 'ENGINE_STATE_FILE_ID';

function props_() { return PropertiesService.getScriptProperties(); }

function getCacheFolder_() {
  var id = props_().getProperty(PROP_CACHE_FOLDER);
  var f = folderByIdRestore_(id, 'engine cache'); // back out of the Trash if deleted by mistake
  if (f) return f;
  var folder = getDataFolder_().createFolder(SETTINGS.CACHE_FOLDER_NAME);
  props_().setProperty(PROP_CACHE_FOLDER, folder.getId());
  return folder;
}


/* ----------------------------- file helpers ----------------------------- */

function isGzipBytes_(bytes) {
  return bytes.length > 2 && bytes[0] === 31 && (bytes[1] === -117 || bytes[1] === 139);
}

/** Raw bytes of an engine file (gzip as stored). */
function readFileBytes_(id) {
  return DriveApp.getFileById(id).getBlob().getBytes();
}

/** Text of an engine file — transparently un-gzips (old plain files still read fine). */
function readTextFile_(id) {
  var blob = DriveApp.getFileById(id).getBlob();
  var bytes = blob.getBytes();
  if (isGzipBytes_(bytes)) {
    return Utilities.ungzip(Utilities.newBlob(bytes, 'application/x-gzip')).getDataAsString('UTF-8');
  }
  return blob.getDataAsString('UTF-8');
}

function readJsonFile_(id) {
  return JSON.parse(readTextFile_(id));
}

/**
 * Overwrites existingId in place when possible (keeps the same file id), else creates.
 * Everything is stored gzip-compressed (3–4× smaller): less Drive space, faster
 * reads, and the Web App can send the bytes to the dashboard as they are.
 */
function writeJsonFile_(name, obj, existingId) {
  var blob = Utilities.gzip(Utilities.newBlob(JSON.stringify(obj), 'application/json', name), name + '.gz');
  if (existingId) {
    try {
      if (!DriveApp.getFileById(existingId).isTrashed()) {
        Drive.Files.update({ name: name }, existingId, blob);
        return existingId;
      }
    } catch (e) { /* fall through and create */ }
  }
  return getCacheFolder_().createFile(blob).getId();
}

function trashFileQuiet_(id) {
  if (!id) return;
  try { DriveApp.getFileById(id).setTrashed(true); } catch (e) { /* ignore */ }
}


/* -------------------------------- state -------------------------------- */

function newState_() {
  return {
    buildId: Utilities.getUuid(), // changes on full recompute → dashboard does a full reload
    version: 0,                   // ms timestamp of last master write
    deltaFloor: 0,                // clients older than this need a full reload
    masterParts: [],              // file ids of dashboard_master_part_N.json
    recentParts: null,            // the tail of masterParts without the months kept in Cloudflare R2 (website first load)
    recentInfo: null,             // { version, from, halves, dropped } for recentParts
    frozenSig: '',                // R2.gs: half-years left out of this master (read from Cloudflare R2), e.g. "FY25-26_H1,FY25-26_H2"
    frozenHalves: {},             // { FY25-26_H1: { start, end } } for the website
    forceFull: false,             // next run rebuilds everything (after a failed freeze check)
    headers: [],
    keyColumn: '',
    dateColumns: [],
    sheetView: { divisors: {}, formats: {} }, // Ton/Lacs + number formats for the DASHBOARD_MASTER sheet only
    rowCount: 0,
    deltas: [],                   // [{id, version, upserts, deletes}]
    sources: {},                  // SRC → { files: { fileId: {cacheId, fileName, lastUpdated, sig, rows} } }
    pendingKeys: {},              // keys whose master rows still need recomputing (crash safety)
    mirrorDirty: false            // master sheets not yet rewritten from the latest JSON
  };
}

function loadState_() {
  var id = props_().getProperty(PROP_STATE_FILE);
  if (!id) return newState_();
  try {
    var s = readJsonFile_(id);
    var d = newState_();
    Object.keys(d).forEach(function (k) { if (s[k] === undefined) s[k] = d[k]; });
    return s;
  } catch (e) {
    return newState_();
  }
}

function saveState_(state) {
  var id = props_().getProperty(PROP_STATE_FILE);
  var newId = writeJsonFile_('engine_state.json', state, id);
  if (newId !== id) props_().setProperty(PROP_STATE_FILE, newId);
  try { CacheService.getScriptCache().remove(API_STATE_KEY_); } catch (e) { /* ignore */ }
}

/* The dashboard asks for the state on every call (one per data part). Reading it from
   Drive each time is slow, so the fields the web app needs are kept in the script cache
   for 5 minutes and dropped whenever the engine saves a new state. */
var API_STATE_KEY_ = 'api_state_v1';
var API_STATE_FIELDS_ = ['buildId', 'version', 'headers', 'keyColumn', 'dateColumns', 'sourceNames',
                         'rowCount', 'masterParts', 'deltaFloor', 'deltas', 'recentParts', 'recentInfo', 'frozenHalves'];
function loadApiState_() {
  var cache = CacheService.getScriptCache();
  try { var hit = cache.get(API_STATE_KEY_); if (hit) return JSON.parse(hit); } catch (e) { /* ignore */ }
  var s = loadState_(), slim = {};
  API_STATE_FIELDS_.forEach(function (k) { slim[k] = s[k]; });
  try { var txt = JSON.stringify(slim); if (txt.length < 95000) cache.put(API_STATE_KEY_, txt, 300); } catch (e) { /* too big: just not cached */ }
  return slim;
}


/* ----------------------------- source caches ----------------------------- */

function writeFileCache_(sourceCode, fileId, cols, rows, existingCacheId) {
  return writeJsonFile_('cache_' + sourceCode + '_' + fileId + '.json',
    { sourceCode: sourceCode, fileId: fileId, cols: cols, rows: rows }, existingCacheId);
}

function readFileCacheKeys_(cacheId, keyCol) {
  var data = readJsonFile_(cacheId);
  var k = data.cols.indexOf(keyCol);
  if (k < 0) return [];
  return data.rows.map(function (r) { return normKey_(r[k]); }).filter(Boolean);
}

/**
 * A source's current dataset, rebuilt from its per-file caches (oldest file
 * first, then deduped). If filterKeys is given, only those keys are loaded —
 * keeps memory low for incremental runs.
 * freeze (R2.gs, base source only): { frozen, column } → a file whose rows are all in frozen half-years is
 * not read; a file read for the first time with it gets its list of half-years saved in the manifest.
 */
function loadSourceDataset_(state, sourceCode, keyCol, dateCol, filterKeys, maxCol, freeze) {
  var man = state.sources[sourceCode];
  if (!man) return [];

  var files = Object.keys(man.files)
    .map(function (id) { return man.files[id]; })
    .sort(function (a, b) { return a.lastUpdated - b.lastUpdated; });

  var records = [];
  files.forEach(function (m) {
    if (freeze && !freeze.noSkip && engineFileFrozen_(m.halves, freeze.frozen)) return;
    var data = readJsonFile_(m.cacheId);
    var kIdx = data.cols.indexOf(keyCol);
    if (freeze && !m.halves) {
      var fIdx = data.cols.indexOf(freeze.column);
      if (fIdx >= 0) m.halves = engineHalvesOf_(data.rows.map(function (r) { return r[fIdx]; }));
    }
    data.rows.forEach(function (r) {
      if (filterKeys) {
        if (kIdx < 0) return;
        if (!filterKeys.hasOwnProperty(normKey_(r[kIdx]))) return;
      }
      var rec = {};
      for (var i = 0; i < data.cols.length; i++) rec[data.cols[i]] = r[i];
      records.push(rec);
    });
  });

  return dedupeRecords_(records, keyCol, dateCol, maxCol);
}


/* ---------------------------- master + deltas ---------------------------- */

function hasMaster_(state) {
  return !!(state.masterParts && state.masterParts.length);
}

/** All master rows (parts concatenated, in order). */
function readMasterRows_(state) {
  var rows = [];
  (state.masterParts || []).forEach(function (id) {
    var part = readJsonFile_(id);
    for (var i = 0; i < part.rows.length; i++) rows.push(part.rows[i]);
  });
  return rows;
}

function loadMasterRowsMap_(state) {
  var map = new Map();
  if (!hasMaster_(state)) return map;
  var k = state.headers.indexOf(state.keyColumn);
  readMasterRows_(state).forEach(function (r) { map.set(String(r[k]), r); });
  return map;
}

/**
 * Writes the full master as numbered part files (SETTINGS.MASTER_PART_ROWS rows
 * each). One Web App response can't safely carry 60k+ rows × 70 columns, so the
 * dashboard downloads part 0, 1, 2 … one by one on a full load.
 */
function writeMasterSnapshot_(state, schema, keyColumn, rows, version) {
  state.sheetView = schema.sheetView;
  state.sourceNames = schema.sourceNames;
  var size = SETTINGS.MASTER_PART_ROWS;
  var old = state.masterParts || [];
  var parts = [];

  /* R2.gs: rows of the months that the website loads from Cloudflare R2 ("+ Load last year") go into
     the first parts, every other row after them (same order as before inside each group). The website
     downloads only the parts after them (recentParts); everything else still reads all parts.
     Without R2 (or before an FY is in R2) nothing changes. No extra file is written. */
  var drop = null;
  try { drop = typeof GRA_dashboardDrop_ === 'function' ? GRA_dashboardDrop_(schema.headers) : null; } catch (e) { drop = null; }
  var groups = [rows], nOld = 0;
  if (drop) {
    var oldRows = [], keep = [];
    for (var i = 0; i < rows.length; i++) (drop(rows[i]) ? oldRows : keep).push(rows[i]);
    if (oldRows.length && keep.length) groups = [oldRows, keep];
    else drop = null;
  }
  var chunks = [];
  groups.forEach(function (g, gi) {
    for (var a = 0; a < g.length || (a === 0 && !g.length); a += size) {
      chunks.push(g.slice(a, a + size));
      if (gi === 0 && groups.length > 1) nOld++;
      if (!g.length) break;
    }
  });
  var nParts = chunks.length;
  for (var p = 0; p < nParts; p++) {
    parts.push(writeJsonFile_('dashboard_master_part_' + p + '.json',
      { ok: true, mode: 'part', buildId: state.buildId, version: version, part: p, parts: nParts,
        rows: chunks[p] },
      old[p]));
  }
  for (var x = nParts; x < old.length; x++) trashFileQuiet_(old[x]);

  state.masterParts = parts;
  state.recentParts = drop ? parts.slice(nOld) : null;
  state.recentInfo = drop ? { version: version, from: drop.from, halves: drop.halves, dropped: groups[0].length } : null;
  state.version = version;
  state.headers = schema.headers;
  state.keyColumn = keyColumn;
  state.dateColumns = schema.dateColumns;
  state.rowCount = rows.length;
}

function appendDelta_(state, upserts, deletes, version) {
  if (!upserts.length && !deletes.length) return;
  var id = writeJsonFile_('delta_' + version + '.json',
    { version: version, upserts: upserts, deletes: deletes }, null);
  state.deltas.push({ id: id, version: version, upserts: upserts.length, deletes: deletes.length });
  while (state.deltas.length > SETTINGS.MAX_DELTAS) {
    var old = state.deltas.shift();
    trashFileQuiet_(old.id);
    state.deltaFloor = old.version;
  }
}

function clearDeltas_(state) {
  (state.deltas || []).forEach(function (d) { trashFileQuiet_(d.id); });
  state.deltas = [];
}


/* -------------------------------- resets -------------------------------- */

/** Wipes all engine storage (used by Full rebuild). */
function resetEngineStorage_() {
  var p = props_();
  var folderId = p.getProperty(PROP_CACHE_FOLDER);
  if (folderId) {
    try { DriveApp.getFolderById(folderId).setTrashed(true); } catch (e) { /* ignore */ }
  }
  p.deleteProperty(PROP_CACHE_FOLDER);
  p.deleteProperty(PROP_STATE_FILE);

  // Old (pre-2026-10-06) JSON cache file
  var oldJson = p.getProperty('DASHBOARD_JSON_CACHE_FILE_ID');
  if (oldJson) { trashFileQuiet_(oldJson); p.deleteProperty('DASHBOARD_JSON_CACHE_FILE_ID'); }
}

/** Removes the old hidden _CACHE_* sheets from the previous version. */
function deleteLegacyCacheSheets_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  ss.getSheets().forEach(function (sh) {
    if (/^_CACHE_/.test(sh.getName())) ss.deleteSheet(sh);
  });
}