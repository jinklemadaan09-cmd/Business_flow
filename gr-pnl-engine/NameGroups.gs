/**
 * NAMEGROUPS.GS
 * -------------
 * One company name for the many spellings of a Consignor, Consignee or Customer.
 *
 *  NAME_GROUPS   Type | Spelling | Group | Status | Decided_By | Decided_On
 *    Type      Consignor / Consignee / Customer
 *    Status    APPROVED (Spelling is shown as Group) or SEPARATE (kept as its own company)
 *              or REVOKED (an earlier merge was undone: the spelling is pending again; kept for history)
 *              REVOKED keeps the group it left in Group: the dashboard shows it in a To decide card with that
 *              group and does not club it by Unique ID on its own. Approving it again simply overwrites the row.
 *
 * Consignor spellings with the same PAN (master column CONSIGNOR UNIQUE ID) are clubbed by the dashboard
 * itself, with no row here. A row always wins over the PAN, so an old merge must be revoked first.
 *
 * Only decisions are stored. The dashboard finds new spellings itself from the loaded
 * data, suggests similar groups, and lists them as pending until someone decides.
 *
 * The dashboard reads it with ngGet(session); the owner (or an email in
 * SETTINGS.NAME_APPROVERS) saves decisions with ngSave(session, decisions).
 * The first read creates the sheet and loads the reviewed top-150 list (NameGroupsSeed.js).
 */

var NG_SHEET_ = 'NAME_GROUPS';
var NG_HEADERS_ = ['Type', 'Spelling', 'Group', 'Status', 'Decided_By', 'Decided_On'];
var NG_TYPES_ = { CONSIGNOR: 'Consignor', CONSIGNEE: 'Consignee', CUSTOMER: 'Customer' };
var NG_STATUS_ = { APPROVED: 'APPROVED', SEPARATE: 'SEPARATE', REVOKED: 'REVOKED' };
var NG_CACHE_KEY_ = 'name_groups_v1';
var NG_CACHE_SECONDS_ = 10 * 60;   // sheet edits show up within 10 minutes (dashboard saves: at once)

/* ------------------------------ called by the page ------------------------------ */

/** All decisions for the dashboard: { ok, canEdit, rows: [[type, spelling, group, status, by, on]] }. */
function ngGet(session) {
  try {
    var who = laneSessionUser_(session);
    if (who === false) return { ok: false, error: 'LOGIN_REQUIRED' };
    return { ok: true, canEdit: ngCanEdit_(who), rows: ngReadCached_() };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
}

/**
 * Saves decisions (owner / NAME_APPROVERS only). A spelling that already has a row is updated.
 * decisions: [[type, spelling, group, status]]
 */
function ngSave(session, decisions) {
  try {
    var who = laneSessionUser_(session);
    if (who === false) return { ok: false, error: 'LOGIN_REQUIRED' };
    if (!ngCanEdit_(who)) return { ok: false, error: 'Only the approver can change name groups.' };
    var by = (who && (who.name || who.email)) || ngActiveEmail_() || 'Owner';
    var clean = [];
    (decisions || []).forEach(function (d) {
      var type = ngType_(d && d[0]), sp = ngText_(d && d[1]), grp = ngText_(d && d[2]), st = String(d && d[3] || '').toUpperCase();
      if (!type || !sp || !NG_STATUS_[st]) return;
      if (!grp) grp = sp;
      clean.push([type, sp, grp, st]);
    });
    if (!clean.length) return ngGet(session);
    var lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try {
      ngUpsert_(clean, by, new Date());
      CacheService.getScriptCache().remove(NG_CACHE_KEY_);
    } finally {
      lock.releaseLock();
    }
    return ngGet(session);
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
}

/** Sheet menu: pushes manual edits of NAME_GROUPS to the dashboard at once. */
function refreshNameGroupsCache() {
  CacheService.getScriptCache().remove(NG_CACHE_KEY_);
  show_('NAME_GROUPS re-read. Dashboards pick up the change the next time they open or sync.');
}

/* ------------------------------ helpers ------------------------------ */

function ngActiveEmail_() {
  try { return String(Session.getActiveUser().getEmail() || '').toLowerCase(); } catch (e) { return ''; }
}

function ngCanEdit_(who) {
  var owner = '';
  try { owner = String(Session.getEffectiveUser().getEmail() || '').toLowerCase(); } catch (e) {}
  var list = (SETTINGS.NAME_APPROVERS || []).map(function (e) { return String(e).trim().toLowerCase(); });
  if (owner) list.push(owner);
  var email = who && who.email ? String(who.email).toLowerCase() : ngActiveEmail_();
  return !!email && list.indexOf(email) >= 0;
}

function ngText_(v) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim(); }

function ngType_(v) { return NG_TYPES_[ngText_(v).toUpperCase()] || ''; }

function ngRowKey_(type, spelling) { return ngType_(type) + '|' + ngText_(spelling).toUpperCase(); }

function ngSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(NG_SHEET_);
  if (!sh) {
    sh = ss.insertSheet(NG_SHEET_);
    sh.getRange(1, 1, 1, NG_HEADERS_.length).setValues([NG_HEADERS_]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

/** Adds the reviewed seed list once per seed version (rows already in the sheet win). */
function ngSeed_() {
  if (typeof NAME_GROUP_SEED_ === 'undefined') return;
  var props = props_();
  if (props.getProperty('NG_SEED_VERSION') === NAME_GROUP_SEED_VERSION_) return;
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    if (props.getProperty('NG_SEED_VERSION') === NAME_GROUP_SEED_VERSION_) return;
    ngUpsert_(NAME_GROUP_SEED_, 'Top 150 review', new Date(), true);
    props.setProperty('NG_SEED_VERSION', NAME_GROUP_SEED_VERSION_);
  } finally {
    lock.releaseLock();
  }
}

/** Writes rows [type, spelling, group, status]; keepExisting leaves rows already in the sheet as they are. */
function ngUpsert_(rows, by, when, keepExisting) {
  var sh = ngSheet_();
  var last = sh.getLastRow();
  var values = last > 1 ? sh.getRange(2, 1, last - 1, NG_HEADERS_.length).getValues() : [];
  var at = {};
  values.forEach(function (r, i) { if (ngText_(r[1])) at[ngRowKey_(r[0], r[1])] = i; });
  var added = [];
  rows.forEach(function (d) {
    var row = [ngType_(d[0]), ngText_(d[1]), ngText_(d[2]), String(d[3]).toUpperCase(), by, when];
    var k = ngRowKey_(row[0], row[1]);
    if (at[k] !== undefined) {
      if (!keepExisting) values[at[k]] = row;
    } else {
      at[k] = values.length + added.length;
      added.push(row);
    }
  });
  if (values.length) sh.getRange(2, 1, values.length, NG_HEADERS_.length).setValues(values);
  if (added.length) sh.getRange(values.length + 2, 1, added.length, NG_HEADERS_.length).setValues(added);
  SpreadsheetApp.flush();
}

function ngReadCached_() {
  ngSeed_();
  var cache = CacheService.getScriptCache();
  var hit = cache.get(NG_CACHE_KEY_);
  if (hit) { try { return JSON.parse(hit); } catch (e) { /* re-read */ } }
  var sh = ngSheet_();
  var last = sh.getLastRow();
  var rows = last > 1 ? sh.getRange(2, 1, last - 1, NG_HEADERS_.length).getValues() : [];
  var out = [];
  rows.forEach(function (r) {
    var type = ngType_(r[0]), sp = ngText_(r[1]), st = String(r[3] || '').trim().toUpperCase();
    if (!type || !sp || !NG_STATUS_[st]) return;
    var on = r[5] instanceof Date ? Utilities.formatDate(r[5], Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm') : ngText_(r[5]);
    out.push([type, sp, ngText_(r[2]) || sp, st, ngText_(r[4]), on]);
  });
  try { cache.put(NG_CACHE_KEY_, JSON.stringify(out), NG_CACHE_SECONDS_); } catch (e) { /* over 100 KB: read each time */ }
  return out;
}
