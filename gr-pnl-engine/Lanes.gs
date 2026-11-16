/**
 * LANES.GS
 * --------
 * Lane structure + lane targets, kept in this spreadsheet so every dashboard user
 * sees the same lanes and targets (no per-browser upload).
 *
 *  LANE_ORIGIN   Origin | Origin Circle | Booking Lane
 *  LANE_DEST     Destination | Destination Circle | Broader Lane (L1) | Broader Lane (L2) | Broader Lane (L3)
 *  LANE_TARGETS  one row per target (see LANE_TARGET_HEADERS_). Many target files can live here
 *                side by side: each file is one Target_Set. Uploading a file again replaces only
 *                that set's rows. Rows can also be typed / pasted straight into the sheet.
 *
 * Levels (which master field a target row is matched on):
 *   Origin_Level  LANE (Booking Lane, default) | CIRCLE | ZONE | BRANCH | ALL
 *   Dest_Level    LANE2 (Broader Lane L2, default) | LANE1 | LANE3 | CIRCLE | ZONE | DESTINATION | ALL
 * Per           WEEK (default) | MONTH | DAY — the target is scaled to the days of the period shown.
 * Weights are in MT and money in Lacs in the sheet; the dashboard gets kg and ₹.
 *
 * The dashboard reads it with lanesGet(session); the owner (or an email in
 * SETTINGS.LANE_EDITORS) can save an uploaded file with lanesSave(session, payload).
 */

var LANE_SHEETS_ = { ORIGIN: 'LANE_ORIGIN', DEST: 'LANE_DEST', TARGETS: 'LANE_TARGETS' };
var LANE_ORIGIN_HEADERS_ = ['Origin', 'Origin Circle', 'Booking Lane'];
var LANE_DEST_HEADERS_ = ['Destination', 'Destination Circle', 'Broader Lane (L1)', 'Broader Lane (L2)', 'Broader Lane (L3)'];
var LANE_TARGET_HEADERS_ = ['Target_Set', 'Active', 'Origin_Level', 'Origin', 'Dest_Level', 'Destination', 'Load_Type',
  'Per', 'From_Date', 'To_Date', 'GR_Count', 'CWeight_MT', 'AWeight_MT', 'Basic_Freight_Lacs', 'Total_Freight_Lacs', 'Notes'];
var LANE_CACHE_KEY_ = 'lanes_v1';
var LANE_CACHE_SECONDS_ = 10 * 60;   // sheet edits show up within 10 minutes (uploads: at once)

/* ------------------------------ called by the page ------------------------------ */

/** Lane map + targets for the dashboard. */
function lanesGet(session) {
  try {
    var who = laneSessionUser_(session);
    if (who === false) return { ok: false, error: 'LOGIN_REQUIRED' };
    var data = laneReadCached_();
    data.ok = true;
    data.canEdit = laneCanEdit_(who);
    return data;
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
}

/**
 * Saves an uploaded lane file for everyone (owner / LANE_EDITORS only).
 * payload: { origin?: [[origin, circle, lane]], dest?: [[dest, circle, l1, l2, l3]],
 *            targetSets?: [{ name, rows: [[...LANE_TARGET_HEADERS_ order, sheet units]] }],
 *            deleteSets?: [name] }
 */
function lanesSave(session, payload) {
  try {
    var who = laneSessionUser_(session);
    if (who === false) return { ok: false, error: 'LOGIN_REQUIRED' };
    if (!laneCanEdit_(who)) return { ok: false, error: 'Only the dashboard owner can change lanes and targets for everyone.' };
    payload = payload || {};
    var lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try {
      if (Array.isArray(payload.origin) && payload.origin.length) laneWriteTable_(LANE_SHEETS_.ORIGIN, LANE_ORIGIN_HEADERS_, payload.origin);
      if (Array.isArray(payload.dest) && payload.dest.length) laneWriteTable_(LANE_SHEETS_.DEST, LANE_DEST_HEADERS_, payload.dest);
      var replace = {};
      (payload.targetSets || []).forEach(function (s) { replace[laneKey_(s.name)] = s; });
      (payload.deleteSets || []).forEach(function (n) { replace[laneKey_(n)] = { name: n, rows: [] }; });
      if (Object.keys(replace).length) {
        var sh = laneSheet_(LANE_SHEETS_.TARGETS, LANE_TARGET_HEADERS_);
        var keep = laneValues_(sh).filter(function (r) { return !replace[laneKey_(r[0])]; });
        Object.keys(replace).forEach(function (k) {
          var s = replace[k];
          (s.rows || []).forEach(function (r) {
            var row = LANE_TARGET_HEADERS_.map(function (_, i) { return r[i] == null ? '' : r[i]; });
            row[0] = s.name;
            keep.push(row);
          });
        });
        laneWriteTable_(LANE_SHEETS_.TARGETS, LANE_TARGET_HEADERS_, keep);
      }
      SpreadsheetApp.flush();
      CacheService.getScriptCache().remove(LANE_CACHE_KEY_);
    } finally {
      lock.releaseLock();
    }
    return lanesGet(session);
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
}

/** Sheet menu: creates the three lane sheets (empty, with headers) if they are missing. */
function setupLaneSheets() {
  ownerOnly_();
  laneSheet_(LANE_SHEETS_.ORIGIN, LANE_ORIGIN_HEADERS_);
  laneSheet_(LANE_SHEETS_.DEST, LANE_DEST_HEADERS_);
  laneSheet_(LANE_SHEETS_.TARGETS, LANE_TARGET_HEADERS_);
  CacheService.getScriptCache().remove(LANE_CACHE_KEY_);
  show_('Lane sheets ready: ' + [LANE_SHEETS_.ORIGIN, LANE_SHEETS_.DEST, LANE_SHEETS_.TARGETS].join(', ') +
        '. Upload the lane file from the dashboard (⬆ Lane Mapping) or paste rows here.');
}

/** Sheet menu: pushes manual edits of the lane sheets to the dashboard at once. */
function refreshLaneCache() {
  CacheService.getScriptCache().remove(LANE_CACHE_KEY_);
  show_('Lane sheets re-read. Dashboards pick up the change the next time they open or sync.');
}

/* ------------------------------ helpers ------------------------------ */

/** session user, null when sign-in is off, false when the session is not valid. */
function laneSessionUser_(session) {
  if (!SETTINGS.REQUIRE_LOGIN) return null;
  return checkSession_(session) || false;
}

function laneCanEdit_(who) {
  var owner = '', active = '';
  try { owner = String(Session.getEffectiveUser().getEmail() || '').toLowerCase(); } catch (e) {}
  try { active = String(Session.getActiveUser().getEmail() || '').toLowerCase(); } catch (e) {}
  var editors = (SETTINGS.LANE_EDITORS || []).map(function (e) { return String(e).trim().toLowerCase(); });
  if (owner) editors.push(owner);
  var email = who && who.email ? String(who.email).toLowerCase() : active;
  return !!email && editors.indexOf(email) >= 0;
}

function laneKey_(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toUpperCase(); }

function laneSheet_(name, headers) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

/** Data rows (no header), trimmed to the header width. */
function laneValues_(sh) {
  var last = sh.getLastRow(), cols = sh.getLastColumn();
  if (last < 2 || cols < 1) return [];
  return sh.getRange(2, 1, last - 1, cols).getValues().filter(function (r) {
    return r.some(function (v) { return v !== '' && v != null; });
  });
}

function laneWriteTable_(name, headers, rows) {
  var sh = laneSheet_(name, headers);
  sh.clearContents();
  sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
  if (rows.length) {
    var data = rows.map(function (r) { return headers.map(function (_, i) { return r[i] == null ? '' : r[i]; }); });
    sh.getRange(2, 1, data.length, headers.length).setValues(data);
  }
}

function laneHeaderIndex_(sh, headers) {
  var cols = sh.getLastColumn();
  var h = cols ? sh.getRange(1, 1, 1, cols).getValues()[0].map(laneKey_) : [];
  var idx = {};
  headers.forEach(function (name, i) { var j = h.indexOf(laneKey_(name)); idx[i] = j >= 0 ? j : (h.length ? -1 : i); });
  return idx;
}

function laneReadCached_() {
  var cache = CacheService.getScriptCache();
  var hit = cache.get(LANE_CACHE_KEY_);
  if (hit) { try { return JSON.parse(hit); } catch (e) { /* re-read */ } }
  var data = laneReadSheets_();
  try { cache.put(LANE_CACHE_KEY_, JSON.stringify(data), LANE_CACHE_SECONDS_); } catch (e) { /* over 100 KB: read each time */ }
  return data;
}

function laneReadSheets_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var tz = ss.getSpreadsheetTimeZone() || 'Asia/Kolkata';
  var txt = function (v) { return v == null ? '' : String(v).replace(/\s+/g, ' ').trim(); };
  var clean = function (v) { var s = txt(v); return (!s || s === '#N/A' || s === '0') ? '' : s; };
  var num = function (v) { if (v === '' || v == null) return null; var n = Number(String(v).replace(/,/g, '')); return isFinite(n) ? n : null; };
  var day = function (v) {
    if (v instanceof Date) return Utilities.formatDate(v, tz, 'yyyy-MM-dd');
    var s = txt(v), m = s.match(/^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{4})$/);   // dd-mm-yyyy
    if (m) return m[3] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[1]).slice(-2);
    return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
  };

  var origin = [], dest = [], targets = [];
  var so = ss.getSheetByName(LANE_SHEETS_.ORIGIN);
  if (so) {
    var io = laneHeaderIndex_(so, LANE_ORIGIN_HEADERS_);
    laneValues_(so).forEach(function (r) {
      var o = txt(r[io[0]]), lane = clean(r[io[2]]);
      if (o && lane) origin.push([o, clean(io[1] >= 0 ? r[io[1]] : ''), lane]);
    });
  }
  var sd = ss.getSheetByName(LANE_SHEETS_.DEST);
  if (sd) {
    var id = laneHeaderIndex_(sd, LANE_DEST_HEADERS_);
    laneValues_(sd).forEach(function (r) {
      var d = txt(r[id[0]]);
      if (d) dest.push([d, clean(id[1] >= 0 ? r[id[1]] : ''), clean(r[id[2]]), clean(r[id[3]]), clean(r[id[4]])]);
    });
  }
  var st = ss.getSheetByName(LANE_SHEETS_.TARGETS);
  if (st) {
    var it = laneHeaderIndex_(st, LANE_TARGET_HEADERS_);
    var g = function (r, i) { return it[i] >= 0 ? r[it[i]] : ''; };
    laneValues_(st).forEach(function (r) {
      var active = laneKey_(g(r, 1));
      if (active === 'NO' || active === 'N' || active === 'FALSE') return;
      var t = {
        set: txt(g(r, 0)) || 'Targets',
        oLevel: laneKey_(g(r, 2)) || 'LANE', origin: txt(g(r, 3)) || 'ALL',
        dLevel: laneKey_(g(r, 4)) || 'LANE2', dest: txt(g(r, 5)) || 'ALL',
        loadType: laneKey_(g(r, 6)), per: laneKey_(g(r, 7)) || 'WEEK',
        from: day(g(r, 8)), to: day(g(r, 9)),
        count: num(g(r, 10)),
        cweight: num(g(r, 11)) == null ? null : num(g(r, 11)) * 1000,
        aweight: num(g(r, 12)) == null ? null : num(g(r, 12)) * 1000,
        freight: num(g(r, 13)) == null ? null : num(g(r, 13)) * 100000,
        total: num(g(r, 14)) == null ? null : num(g(r, 14)) * 100000,
        notes: txt(g(r, 15))
      };
      if (t.loadType === 'SML') t.loadType = 'LTL';
      if (t.loadType === 'ALL') t.loadType = '';
      if ([t.count, t.cweight, t.aweight, t.freight, t.total].some(function (v) { return v != null; })) targets.push(t);
    });
  }
  return { version: Date.now(), origin: origin, dest: dest, targets: targets };
}
