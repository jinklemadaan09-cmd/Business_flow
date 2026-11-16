/**
 * LAYOUT.GS
 * ---------
 * Pro mode: the dashboard layout an admin designs (slicer order, tab order and names,
 * table / chart order, hidden items, titles) saved for everyone.
 *
 *  DASHBOARD_LAYOUT   Version | Saved_By | Saved_On | Layout_Json
 *    One row per save; the last row is the layout everyone sees. Older rows are the history.
 *
 * The dashboard reads it with layoutGet(session); the owner (or an email in
 * SETTINGS.DASH_ADMINS) saves with layoutSave(session, json).
 */

var LAYOUT_SHEET_ = 'DASHBOARD_LAYOUT';
var LAYOUT_HEADERS_ = ['Version', 'Saved_By', 'Saved_On', 'Layout_Json'];
var LAYOUT_CACHE_KEY_ = 'dash_layout_v1';
var LAYOUT_CACHE_SECONDS_ = 10 * 60;
var LAYOUT_HISTORY_ = 20;
var LAYOUT_MAX_CHARS_ = 45000;   // one sheet cell holds 50,000 characters

/* ------------------------------ called by the page ------------------------------ */

/** { ok, canEdit, layout, version, savedBy, savedOn, history: [{version, by, on, layout}] } */
function layoutGet(session) {
  try {
    var who = laneSessionUser_(session);
    if (who === false) return { ok: false, error: 'LOGIN_REQUIRED' };
    var d = layoutReadCached_();
    d.ok = true;
    d.canEdit = layoutCanEdit_(who);
    return d;
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
}

/** Saves a new layout version for everyone (owner / DASH_ADMINS only). */
function layoutSave(session, json) {
  try {
    var who = laneSessionUser_(session);
    if (who === false) return { ok: false, error: 'LOGIN_REQUIRED' };
    if (!layoutCanEdit_(who)) return { ok: false, error: 'Only an admin can change the dashboard layout.' };
    var text = String(json == null ? '' : json);
    JSON.parse(text || '{}');   // must be valid JSON
    if (text.length > LAYOUT_MAX_CHARS_) return { ok: false, error: 'Layout is too large to save.' };
    var by = (who && (who.name || who.email)) || ngActiveEmail_() || 'Owner';
    var lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try {
      var sh = layoutSheet_();
      var last = sh.getLastRow();
      var v = last > 1 ? (Number(sh.getRange(last, 1).getValue()) || last - 1) + 1 : 1;
      sh.appendRow([v, by, new Date(), text]);
      CacheService.getScriptCache().remove(LAYOUT_CACHE_KEY_);
    } finally {
      lock.releaseLock();
    }
    return layoutGet(session);
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
}

/* ------------------------------ helpers ------------------------------ */

function layoutCanEdit_(who) {
  var owner = '';
  try { owner = String(Session.getEffectiveUser().getEmail() || '').toLowerCase(); } catch (e) {}
  var list = (SETTINGS.DASH_ADMINS || []).map(function (e) { return String(e).trim().toLowerCase(); });
  if (owner) list.push(owner);
  var email = who && who.email ? String(who.email).toLowerCase() : ngActiveEmail_();
  return !!email && list.indexOf(email) >= 0;
}

function layoutSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(LAYOUT_SHEET_);
  if (!sh) {
    sh = ss.insertSheet(LAYOUT_SHEET_);
    sh.getRange(1, 1, 1, LAYOUT_HEADERS_.length).setValues([LAYOUT_HEADERS_]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

function layoutReadCached_() {
  var cache = CacheService.getScriptCache();
  var hit = cache.get(LAYOUT_CACHE_KEY_);
  if (hit) { try { return JSON.parse(hit); } catch (e) { /* re-read */ } }
  var d = layoutRead_();
  try { cache.put(LAYOUT_CACHE_KEY_, JSON.stringify(d), LAYOUT_CACHE_SECONDS_); } catch (e) { /* too big for cache: fine */ }
  return d;
}

function layoutRead_() {
  var sh = layoutSheet_();
  var last = sh.getLastRow();
  var out = { layout: {}, version: 0, savedBy: '', savedOn: '', history: [] };
  if (last < 2) return out;
  var first = Math.max(2, last - LAYOUT_HISTORY_ + 1);
  var vals = sh.getRange(first, 1, last - first + 1, 4).getValues();
  var tz = Session.getScriptTimeZone();
  vals.reverse().forEach(function (r) {
    var lay = {};
    try { lay = JSON.parse(String(r[3] || '{}')); } catch (e) { return; }
    var on = r[2] instanceof Date ? Utilities.formatDate(r[2], tz, 'yyyy-MM-dd HH:mm') : String(r[2] || '');
    out.history.push({ version: Number(r[0]) || 0, by: String(r[1] || ''), on: on, layout: lay });
  });
  if (out.history.length) {
    var h = out.history[0];
    out.layout = h.layout; out.version = h.version; out.savedBy = h.by; out.savedOn = h.on;
  }
  return out;
}
