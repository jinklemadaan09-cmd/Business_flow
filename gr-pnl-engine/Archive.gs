/**
 * GR PNL Engine: half-year archive + sheet size guard.
 *
 * Lives inside the GR PNL Engine Apps Script project (next to WEBAPP / JOINENGINE). Every name starts
 * with GRA_ so nothing clashes with engine code.
 *
 * What it does, every night (and on its own after a long run):
 *  1. Size guard: counts cells in the engine spreadsheet (and the mirror spreadsheet if separate).
 *     Mail at WARN_PCT (70%) and URGENT_PCT (85%) of Google's 10,000,000 cell limit.
 *  2. Archive: every finished half-year (Apr-Sep = H1, Oct-Mar = H2) of the engine master is saved in
 *     Drive > GR_ARCHIVE as its own Google Sheet + a gzip JSON copy. A half-year is rebuilt whenever its
 *     data changes (a month file replaced, a new join, a new column). Each rebuild is compared with the
 *     previous version and a summary goes to ARCHIVE_CHANGES and by mail. The previous version is kept in
 *     GR_ARCHIVE/old for KEEP_OLD_DAYS days.
 *     When Cloudflare R2 keys are saved (R2.gs), every verified half-year JSON is also copied to the R2
 *     bucket at the end of the run, for the dashboard website's "+ Load last year".
 *  3. Mirror trim: rows older than KEEP_MONTHS leave the DASHBOARD_MASTER mirror tab, but only rows whose
 *     GR NO is present in a verified archive. Nothing is removed without a checked copy.
 *
 * The dashboard is not affected: it reads the engine JSON, which still holds every month.
 *
 * Run once from the editor: GRA_setup  (creates the settings tabs and the nightly trigger)
 * Any time:                 GRA_runNow (same as the nightly run), GRA_dryRun (only reports, changes nothing)
 */

var GRA_TAB = { settings: 'ARCHIVE_SETTINGS', log: 'ARCHIVE_LOG', changes: 'ARCHIVE_CHANGES', files: 'ARCHIVE_FILES' };
var GRA_CELL_LIMIT = 10000000;
var GRA_TIME_BUDGET_MS = 4.5 * 60 * 1000;   // Apps Script stops at 6 min
var GRA_CHUNK_ROWS = 4000;
var GRA_STATE_KEY = 'GRA_BUILD_STATE';

var GRA_DEFAULTS = [
  ['ARCHIVE_ON', 'YES', 'YES = archives are built and the mirror tab is trimmed. NO = check and report only (dry run), nothing is changed.'],
  ['KEEP_MONTHS', '6', 'How many months to keep in the mirror tab (including the current month). Older rows are removed only after their archive is verified.'],
  ['MIRROR_TAB', '', 'Mirror tab name. Blank = the engine one (MIRROR_SHEET_NAME, DASHBOARD_MASTER).'],
  ['MIRROR_SHEET', '', 'Mirror spreadsheet link / ID. Blank = the engine one (Config.gs MIRROR_FILE_ID).'],
  ['DATE_COLUMN', 'GR DT', 'Date column (the half-year is taken from it)'],
  ['KEY_COLUMN', 'GR NO', 'Unique key of each row'],
  ['SUM_COLUMNS', 'TOTAL FREIGHT, TOTAL EXPENSE, CWEIGHT, AWEIGHT, BASIC FREIGHT', 'The change mail shows the old vs new total of these columns'],
  ['ARCHIVE_FOLDER_ID', '', 'Drive folder ID for the archive. Blank = a GR_ARCHIVE folder is created inside GR_DASHBOARD_DATA.'],
  ['KEEP_OLD_VERSION', 'NO', 'NO = a rebuilt half-year REPLACES its archive file (one file per period, the old one goes to Drive Trash). YES = keep the old version in GR_ARCHIVE/old for KEEP_OLD_DAYS days.'],
  ['KEEP_OLD_DAYS', '90', 'Only when KEEP_OLD_VERSION = YES: days an old archive version stays in GR_ARCHIVE/old'],
  ['WARN_PCT', '70', 'Send a warning mail when the sheet is this % full (cells)'],
  ['URGENT_PCT', '85', 'Send an URGENT mail when the sheet is this % full (cells)'],
  ['ALERT_EMAILS', '', 'Who gets the mails (comma separated). Blank = script owner.'],
  ['RUN_HOUR', '2', 'Hour of the daily run (0-23). After changing it, run GRA_setup again.'],
  ['ARCHIVE_MAX_CELLS', '9000000', 'Max cells in one archive sheet; above this a Part 2 is created']
];

/* ------------------------------------------------------------------ entry points */

function GRA_setup() {
  var ss = SpreadsheetApp.getActive() || GRA_engineSs_();
  GRA_ensureTabs_(ss);
  var s = GRA_settings_(ss);
  ScriptApp.getProjectTriggers().forEach(function (t) {
    var f = t.getHandlerFunction();
    if (f === 'GRA_nightly' || f === 'GRA_continue') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('GRA_nightly').timeBased().everyDays(1).atHour(Number(s.RUN_HOUR) || 2).create();
  GRA_log_(ss, 'SETUP', 'Nightly run at ' + (Number(s.RUN_HOUR) || 2) + ':00 set', '');
}

function GRA_nightly(e) { GRA_run_(false); }
function GRA_continue(e) { GRA_run_(false); }
function GRA_runNow() { GRA_showResult_('Run archive now', GRA_run_(false, true)); }
function GRA_dryRun() { GRA_showResult_('Dry run', GRA_run_(true, true)); }

/** Menu: shows where the archive is. */
function GRA_openFolder() {
  var ss = GRA_engineSs_(), s = GRA_settings_(ss), id = GRA_idFrom_(s.ARCHIVE_FOLDER_ID);
  if (!id) {
    GRA_dialog_('Archive folder', 'No archive has been created yet. Use Archive (6 months) > Run archive now.', '');
    return;
  }
  var f = DriveApp.getFolderById(id), owner = '';
  try { owner = f.getOwner().getEmail(); } catch (e) {}
  GRA_dialog_('Archive folder', 'Folder "' + f.getName() + '"' + (owner ? ' in the Drive of ' + owner : '') +
    '. The ARCHIVE_FILES tab lists every archive file with its link.', f.getUrl());
}

/**
 * Hook for the engine: call it just before the engine writes the DASHBOARD_MASTER mirror, so the mirror
 * only ever gets the recent months (plus any older half-year that is not archived yet).
 *   rows = GRA_mirrorFilter(headers, rows);
 */
function GRA_mirrorFilter(headers, rows) {
  var ss = GRA_engineSs_(), s = GRA_settings_(ss);
  var di = GRA_col_(headers, s.DATE_COLUMN);
  if (di < 0) return rows;
  var cutoff = GRA_cutoffIso_(s), archived = GRA_archivedHalves_(ss);
  return rows.filter(function (r) {
    var iso = GRA_iso_(r[di]);
    return !iso || iso >= cutoff || !archived[GRA_halfOf_(iso).key];
  });
}

/** Sub-menu added to the engine's GR PNL Engine menu (Main.gs onOpen). */
function GRA_menu_(ui) {
  return ui.createMenu('Archive (6 months)')
    .addItem('Dry run (check only, nothing changes)', 'GRA_dryRun')
    .addItem('Run archive now', 'GRA_runNow')
    .addItem('Setup (nightly trigger)', 'GRA_setup')
    .addSeparator()
    .addItem('Open archive folder', 'GRA_openFolder')
    .addItem('Archive status (optional, it checks itself)', 'GRA_checkFiles')
    .addSeparator()
    .addItem('Cloudflare R2: save keys', 'R2_saveKeys')
    .addItem('Cloudflare R2: test connection', 'R2_test')
    .addItem('Cloudflare R2: upload archive now', 'R2_uploadNow');
}

/* ------------------------------------------------------------------ main run */

function GRA_run_(dry, fromMenu) {
  // The archive never holds the engine's script lock for long, so Refresh / the hourly engine refresh are
  // never blocked by it. It uses its own lock, and gives way while the engine still has work to finish.
  if (!dry && GRA_engineBusy_()) {
    GRA_scheduleContinue_(5);
    return { busy: true, text: 'The engine refresh is still working (new or changed files). ' +
      'The archive waits for it and starts by itself in about 5 minutes.' };
  }
  var lock = LockService.getDocumentLock() || LockService.getScriptLock();
  if (!lock.tryLock(fromMenu ? 30000 : 20000)) {
    if (!dry) GRA_scheduleContinue_(1);
    return { busy: true, text: 'An archive run is already going. It continues by itself; check ARCHIVE_LOG in a few minutes.' };
  }
  var result = { text: '', building: false };
  if (!dry) GRA_ensureNightly_();   // any real run also makes sure the nightly 2 AM run exists
  var t0 = Date.now(), ss = GRA_engineSs_();
  try {
    GRA_ensureTabs_(ss);
    var s = GRA_settings_(ss);
    if (String(s.ARCHIVE_ON).toUpperCase() !== 'YES') dry = true;
    var notes = [];

    var size = GRA_checkSize_(ss, s);
    notes.push(size);

    var master = GRA_readMaster_(ss, s);
    var halves = GRA_groupHalves_(master, s);
    // Memory: the full master (all months x all columns) is the biggest thing in this run. Each half-year
    // now holds its own rows, so the full list is let go here, and each half-year's rows as soon as it is done.
    master.rows = null;
    var done = true;
    for (var i = 0; i < halves.length; i++) {
      var h = halves[i];
      if (!h.complete) continue;
      var fp = GRA_fingerprint_(master.headers, h.rows, s);
      var old = GRA_storedFp_(h.key);
      if (old && old.hash === fp.hash) { h.rows = null; continue; }
      if (dry) { notes.push(h.label + ': ' + (old ? 'data changed, will be rebuilt' : 'archive will be created') + ' (' + h.rows.length + ' rows)'); h.rows = null; continue; }
      var res = GRA_buildHalf_(ss, s, master, h, fp, old, t0);
      h.rows = null;
      if (res === 'timeout') { done = false; break; }
      if (res === 'superseded') { notes.push(h.label + ': finished by another run, nothing written twice'); continue; }
      notes.push(res);
    }
    halves = null; master = null; h = null;   // the mirror trim and the self-check below need none of it

    if (done) {
      GRA_clearContinue_();
      var trim = GRA_trimMirror_(ss, s, dry);
      notes.push(trim);
      if (!dry) {
        GRA_purgeOld_(s);
        var heal = GRA_heal_(ss, s);
        if (heal.rebuild.length) { GRA_scheduleContinue_(1); result.building = true; notes.push('Rebuilding: ' + heal.rebuild.join(', ')); }
        else GRA_statusMail_(s, heal);
        if (heal.fixes.length) notes.push('Fixed: ' + heal.fixes.join('; '));
        if (!heal.rebuild.length && typeof GRA_r2Sync_ === 'function') {   // R2.gs: copy for the website (only when keys are saved)
          var r2 = GRA_r2Sync_(ss, s, t0, false);
          if (r2) notes.push(r2);
        }
      }
    } else {
      GRA_scheduleContinue_(GRA_engineBusy_() ? 5 : 1);
      notes.push('Time limit reached, continues by itself in 1 min');
      result.building = true;
    }
    result.text = notes.filter(String).join('\n');
    GRA_log_(ss, dry ? 'DRY RUN' : 'RUN', notes.filter(String).join(' | '), Math.round((Date.now() - t0) / 1000) + ' s');
  } catch (err) {
    result.text = 'Error: ' + String(err && err.message || err) + '\nNothing was deleted.';
    GRA_log_(ss, 'ERROR', String(err && err.stack || err), '');
    GRA_mail_(GRA_settings_(ss), 'GR Archive: ERROR', '<p>The archive run failed. Nothing was deleted.</p><pre>' + GRA_esc_(String(err && err.stack || err)) + '</pre>');
  } finally {
    lock.releaseLock();
  }
  return result;
}

/** Menu feedback: what happened and where the archive is. Silent when there is no UI (triggers). */
function GRA_showResult_(title, r) {
  if (!r) return;
  var text = r.text, url = '';
  if (r.building) text += '\n\nThe archive is being written in steps of about 5 minutes and continues by itself. ' +
    'Files are named "... - building" until they are checked. You get a mail when it is ready.';
  try { var s = GRA_settings_(GRA_engineSs_()), id = GRA_idFrom_(s.ARCHIVE_FOLDER_ID); if (id) url = DriveApp.getFolderById(id).getUrl(); } catch (e) {}
  GRA_dialog_(title, text + '\n\nFull details: ARCHIVE_LOG tab.', url);
}

function GRA_dialog_(title, text, url) {
  try {
    var html = '<div style="font:13px Arial;line-height:1.5;white-space:pre-wrap">' + GRA_esc_(text) + '</div>' +
      (url ? '<p style="font:13px Arial"><a href="' + url + '" target="_blank">Open the GR_ARCHIVE folder</a></p>' : '');
    SpreadsheetApp.getUi().showModalDialog(HtmlService.createHtmlOutput(html).setWidth(520).setHeight(320), title);
  } catch (e) { /* no UI (trigger run) */ }
}

/* ------------------------------------------------------------------ size guard */

function GRA_checkSize_(ss, s) {
  var books = [ss], mid = GRA_mirrorId_(s);
  if (mid && mid !== ss.getId()) books.push(SpreadsheetApp.openById(mid));
  var worst = null, parts = [];
  books.forEach(function (b) {
    var cells = 0, biggest = '', big = 0;
    b.getSheets().forEach(function (sh) {
      var c = sh.getMaxRows() * sh.getMaxColumns();
      cells += c;
      if (c > big) { big = c; biggest = sh.getName(); }
    });
    var pct = cells / GRA_CELL_LIMIT * 100;
    parts.push(b.getName() + ': ' + GRA_fmt_(cells) + ' cells (' + pct.toFixed(1) + '%), largest tab ' + biggest);
    if (!worst || pct > worst.pct) worst = { pct: pct, cells: cells, name: b.getName(), url: b.getUrl(), biggest: biggest };
  });
  var warn = Number(s.WARN_PCT) || 70, urgent = Number(s.URGENT_PCT) || 85;
  if (worst.pct >= warn) {
    var lvl = worst.pct >= urgent ? 'URGENT' : 'Warning';
    GRA_mail_(s, 'GR sheet ' + lvl + ': ' + worst.pct.toFixed(1) + '% full',
      '<p><b>' + GRA_esc_(worst.name) + '</b> has ' + GRA_fmt_(worst.cells) + ' cells, <b>' +
      worst.pct.toFixed(1) + '%</b> of the Google limit of 10,000,000. Largest tab: ' + GRA_esc_(worst.biggest) + '.</p>' +
      '<p>The archive removes old half-years by itself. If this mail comes every day, lower KEEP_MONTHS in ARCHIVE_SETTINGS or check the engine mirror hook.</p>' +
      '<p><a href="' + worst.url + '">Open the sheet</a></p>');
  }
  return parts.join('; ');
}

/* ------------------------------------------------------------------ read the master */

/** Engine master via liveApi (same project). Falls back to the mirror tab when liveApi is not there. */
function GRA_readMaster_(ss, s) {
  if (typeof loadState_ === 'function' && typeof readMasterRows_ === 'function') {
    var state = loadState_();
    if (!state.masterParts || !state.masterParts.length) throw new Error('Engine has no master yet (run Refresh once)');
    return { headers: state.headers, rows: readMasterRows_(state), source: 'engine master build ' + state.buildId,
             dateColumns: state.dateColumns || [], sheetView: state.sheetView || { divisors: {}, formats: {} } };
  }
  if (typeof liveApi === 'function') {
    for (var attempt = 0; attempt < 2; attempt++) {
      var head = GRA_api_({});
      if (!head || head.ok === false) throw new Error('liveApi header failed: ' + JSON.stringify(head).slice(0, 300));
      var rows = [], stale = false;
      for (var p = 0; p < Number(head.parts || 0); p++) {
        var part = GRA_api_({ part: p, build: head.buildId });
        if (part && part.ok === false && /STALE/i.test(String(part.error || part.code || ''))) { stale = true; break; }
        var got = GRA_decodePart_(part);
        for (var k = 0; k < got.length; k++) rows.push(got[k]);
      }
      if (stale) continue;
      return { headers: head.headers, rows: rows, source: 'engine liveApi build ' + head.buildId };
    }
    throw new Error('Engine build changed twice while reading, try again later');
  }
  var sh = GRA_mirrorSheet_(ss, s);
  var v = sh.getDataRange().getValues();
  return { headers: v[0].map(String), rows: v.slice(1), source: 'mirror tab ' + sh.getName() };
}

function GRA_api_(params) {
  var r = liveApi(params);
  if (r && typeof r.getContent === 'function') r = r.getContent();
  if (typeof r === 'string') r = JSON.parse(r);
  return r;
}

function GRA_decodePart_(part) {
  var d = part;
  if (part && part.enc === 'gzip-b64') {
    var blob = Utilities.newBlob(Utilities.base64Decode(part.data), 'application/x-gzip');
    d = JSON.parse(Utilities.ungzip(blob).getDataAsString());
  } else if (part && part.data !== undefined) {
    d = typeof part.data === 'string' ? JSON.parse(part.data) : part.data;
  }
  if (Array.isArray(d)) return d;
  if (d && Array.isArray(d.rows)) return d.rows;
  throw new Error('liveApi part has no rows');
}

/* ------------------------------------------------------------------ half-years */

/** FY runs Apr-Mar. H1 = Apr-Sep, H2 = Oct-Mar. */
function GRA_halfOf_(iso) {
  var y = Number(iso.slice(0, 4)), m = Number(iso.slice(5, 7));
  var fy = m >= 4 ? y : y - 1, h = (m >= 4 && m <= 9) ? 1 : 2;
  var fyName = 'FY' + String(fy).slice(2) + '-' + String(fy + 1).slice(2);
  var start = h === 1 ? fy + '-04-01' : fy + '-10-01';
  var end = h === 1 ? fy + '-09-30' : (fy + 1) + '-03-31';
  var label = fyName + ' ' + (h === 1 ? 'H1 (Apr-Sep ' + fy + ')' : 'H2 (Oct ' + fy + '-Mar ' + (fy + 1) + ')');
  return { key: fyName + '_H' + h, label: label, start: start, end: end };
}

function GRA_groupHalves_(master, s) {
  var di = GRA_col_(master.headers, s.DATE_COLUMN), ki = GRA_col_(master.headers, s.KEY_COLUMN);
  if (di < 0) throw new Error('Date column ' + s.DATE_COLUMN + ' not found');
  if (ki < 0) throw new Error('Key column ' + s.KEY_COLUMN + ' not found');
  var today = GRA_todayIso_(), by = {};
  master.rows.forEach(function (r) {
    var iso = GRA_iso_(r[di]);
    if (!iso) return;
    var h = GRA_halfOf_(iso);
    var b = by[h.key] || (by[h.key] = { key: h.key, label: h.label, start: h.start, end: h.end, rows: [], count: 0, complete: h.end < today });
    b.count++;
    if (b.complete) b.rows.push(r);   // the running half-year is never archived, so its rows are not kept here
  });
  return Object.keys(by).sort().map(function (k) {
    var h = by[k];
    h.rows.sort(function (a, b) {
      var x = GRA_iso_(a[di]), y = GRA_iso_(b[di]);
      if (x !== y) return x < y ? -1 : 1;
      var p = GRA_norm_(a[ki]), q = GRA_norm_(b[ki]);
      return p < q ? -1 : p > q ? 1 : 0;
    });
    return h;
  });
}

function GRA_fingerprint_(headers, rows, s) {
  var hash = GRA_fnv_(headers.join('\u0001'));
  for (var i = 0; i < rows.length; i++) hash = GRA_fnv_(rows[i].map(GRA_norm_).join('\u0001'), hash);
  return { hash: ('00000000' + (hash >>> 0).toString(16)).slice(-8) + ':' + rows.length, rows: rows.length,
           sums: GRA_sums_(headers, rows, s), cols: headers.slice(), config: GRA_configHash_() };
}

function GRA_sums_(headers, rows, s) {
  var out = {};
  String(s.SUM_COLUMNS || '').split(',').map(function (c) { return c.trim(); }).filter(String).forEach(function (c) {
    var i = GRA_col_(headers, c);
    if (i < 0) return;
    var t = 0;
    for (var r = 0; r < rows.length; r++) { var n = Number(rows[r][i]); if (isFinite(n)) t += n; }
    out[c] = t;
  });
  return out;
}

/* ------------------------------------------------------------------ build one half-year (resumable) */

function GRA_buildHalf_(ss, s, master, h, fp, oldFp, t0) {
  var props = PropertiesService.getScriptProperties();
  var st = JSON.parse(props.getProperty(GRA_STATE_KEY) || 'null');
  var cols = master.headers.length;
  var perPart = Math.max(1000, Math.floor((Number(s.ARCHIVE_MAX_CELLS) || 9000000) / cols) - 1);
  var nParts = Math.max(1, Math.ceil(h.rows.length / perPart));

  if (st && (st.key !== h.key || st.hash !== fp.hash)) {   // data changed mid-build: start again
    st.fileIds.forEach(function (id) { try { DriveApp.getFileById(id).setTrashed(true); } catch (e) {} });
    st = null;
  }
  if (!st) {
    var folder = GRA_archiveFolder_(ss, s), ids = [];
    // never two copies of one period: half-written leftovers of this period go first
    var left = folder.getFiles();
    while (left.hasNext()) {
      var lf = left.next();
      if (!lf.isTrashed() && lf.getName().indexOf('GR_MASTER_' + h.key) === 0 && lf.getName().indexOf(' - building') >= 0) lf.setTrashed(true);
    }
    for (var p = 0; p < nParts; p++) {
      var n = Math.min(perPart, h.rows.length - p * perPart);
      var name = 'GR_MASTER_' + h.key + (nParts > 1 ? '_Part' + (p + 1) : '') + ' - building';
      var book = SpreadsheetApp.create(name, n + 1, cols);
      DriveApp.getFileById(book.getId()).moveTo(folder);
      var sh = book.getSheets()[0];
      sh.setName('DATA');
      sh.getRange(1, 1, 1, cols).setValues([master.headers]).setFontWeight('bold');
      sh.setFrozenRows(1);
      ids.push(book.getId());
    }
    st = { key: h.key, hash: fp.hash, fileIds: ids, next: 0, perPart: perPart };
    props.setProperty(GRA_STATE_KEY, JSON.stringify(st));
  }

  var wrote = 0;   // at least one chunk per run, so a slow start can never stall the build
  while (st.next < h.rows.length) {
    if (wrote && Date.now() - t0 > GRA_TIME_BUDGET_MS) {
      GRA_log_(ss, 'BUILDING', h.label + ': ' + GRA_fmt_(st.next) + ' of ' + GRA_fmt_(h.rows.length) + ' rows written to ' +
        st.fileIds.map(function (id) { var f = DriveApp.getFileById(id); return f.getName() + ' ' + f.getUrl(); }).join(', '), '');
      return 'timeout';
    }
    if (!GRA_stillMine_(st)) return 'superseded';
    wrote++;
    var part = Math.floor(st.next / st.perPart), inPart = st.next - part * st.perPart;
    var take = Math.min(GRA_CHUNK_ROWS, st.perPart - inPart, h.rows.length - st.next);
    var view = GRA_view_(master);
    var chunk = h.rows.slice(st.next, st.next + take).map(function (r) {
      var row = r.slice(0, cols); while (row.length < cols) row.push('');
      row = row.map(function (v) { return v === null || v === undefined ? '' : v; });
      view.dateIdx.forEach(function (j) { if (row[j]) row[j] = GRA_toDate_(row[j]); });
      view.divIdx.forEach(function (p) { if (typeof row[p[0]] === 'number') row[p[0]] = Math.round(row[p[0]] / p[1] * 1e6) / 1e6; });
      return row;
    });
    SpreadsheetApp.openById(st.fileIds[part]).getSheets()[0].getRange(inPart + 2, 1, take, cols).setValues(chunk);
    st.next += take;
    props.setProperty(GRA_STATE_KEY, JSON.stringify(st));
  }

  // same look as DASHBOARD_MASTER: dd-MM-yyyy dates + Display_Format
  var vw = GRA_view_(master);
  st.fileIds.forEach(function (id, i) {
    var n = Math.min(st.perPart, h.rows.length - i * st.perPart), sh = SpreadsheetApp.openById(id).getSheets()[0];
    if (!n) return;
    vw.dateIdx.forEach(function (j) { sh.getRange(2, j + 1, n, 1).setNumberFormat('dd-MM-yyyy'); });
    vw.formats.forEach(function (f) { try { sh.getRange(2, f[0] + 1, n, 1).setNumberFormat(f[1]); } catch (e) {} });
  });

  if (!GRA_stillMine_(st)) return 'superseded';   // another run already finished this half-year

  // verify: row count + every key and date read back from the sheets
  var di = GRA_col_(master.headers, s.DATE_COLUMN), ki = GRA_col_(master.headers, s.KEY_COLUMN);
  for (var q = 0; q < st.fileIds.length; q++) {
    var want = h.rows.slice(q * st.perPart, (q + 1) * st.perPart);
    var vs = SpreadsheetApp.openById(st.fileIds[q]).getSheets()[0];
    var got = vs.getLastRow() - 1;
    if (got !== want.length) return GRA_failBuild_(ss, s, h, st, 'Part ' + (q + 1) + ': ' + got + ' rows, expected ' + want.length);
    var kv = vs.getRange(2, ki + 1, got, 1).getValues(), dv = vs.getRange(2, di + 1, got, 1).getValues();
    for (var r = 0; r < got; r++) {
      if (GRA_norm_(kv[r][0]) !== GRA_norm_(want[r][ki]) || GRA_iso_(dv[r][0]) !== GRA_iso_(want[r][di])) {
        return GRA_failBuild_(ss, s, h, st, 'Part ' + (q + 1) + ' row ' + (r + 2) + ' does not match');
      }
    }
  }

  // JSON copy (also what the next rebuild compares against)
  var folder2 = GRA_archiveFolder_(ss, s);
  var json = JSON.stringify({ key: h.key, label: h.label, builtAt: new Date().toISOString(), source: master.source,
                              headers: master.headers, rows: h.rows, fingerprint: fp });
  var gz = Utilities.gzip(Utilities.newBlob(json, 'application/json'), 'GR_MASTER_' + h.key + '.json.gz');
  var jsonFile = folder2.createFile(gz);

  // compare with the previous version, then replace it (one file per period) or keep it in old/
  var prev = GRA_registry_(ss).filter(function (x) { return x.key === h.key && x.status === 'CURRENT' && st.fileIds.indexOf(x.id) < 0; });
  var diff = GRA_diff_(prev, master.headers, h.rows, s, oldFp, fp);
  var stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd_HHmm');
  var keepOld = GRA_keepOld_(s), oldFolder = keepOld ? GRA_subFolder_(folder2, 'old') : null;
  prev.forEach(function (x) {
    try {
      var f = DriveApp.getFileById(x.id);
      if (keepOld) { f.setName(f.getName() + ' (old ' + stamp + ')'); f.moveTo(oldFolder); } else f.setTrashed(true);
    } catch (e) {}
  });
  GRA_markOld_(ss, h.key, stamp, keepOld ? 'OLD ' : 'REPLACED ', st.fileIds);

  var urls = [];
  st.fileIds.forEach(function (id, i) {
    var f = DriveApp.getFileById(id);
    f.setName(f.getName().replace(' - building', ''));
    var n = Math.min(st.perPart, h.rows.length - i * st.perPart);
    GRA_register_(ss, h, 'Sheet' + (st.fileIds.length > 1 ? ' part ' + (i + 1) : ''), id, f.getUrl(), n);
    urls.push(f.getUrl());
  });
  GRA_register_(ss, h, 'JSON', jsonFile.getId(), jsonFile.getUrl(), h.rows.length);

  fp.builtAt = new Date().toISOString();
  PropertiesService.getScriptProperties().setProperty('GRA_FP_' + h.key, JSON.stringify(fp));
  props.deleteProperty(GRA_STATE_KEY);

  GRA_reportChange_(ss, s, h, diff, oldFp, fp, urls, !oldFp);
  var names = st.fileIds.map(function (id) { return DriveApp.getFileById(id).getName(); });
  return h.label + ': archive ' + (oldFp ? 'rebuilt' : 'created') + ' (' + h.rows.length + ' rows, verified): ' +
    names.map(function (n, i) { return n + ' ' + urls[i]; }).join(', ') + ', ' + jsonFile.getName() + ' ' + jsonFile.getUrl();
}

function GRA_failBuild_(ss, s, h, st, why) {
  st.fileIds.forEach(function (id) { try { DriveApp.getFileById(id).setTrashed(true); } catch (e) {} });
  PropertiesService.getScriptProperties().deleteProperty(GRA_STATE_KEY);
  GRA_mail_(s, 'GR Archive: ' + h.label + ' verify fail', '<p>The archive copy failed the check: ' + GRA_esc_(why) +
    '.</p><p>Nothing was deleted and the mirror tab is unchanged. It will retry next night.</p>');
  throw new Error('Verify failed for ' + h.key + ': ' + why);
}

/* ------------------------------------------------------------------ what changed */

function GRA_diff_(prev, headers, rows, s, oldFp, fp) {
  var out = { added: 0, removed: 0, changed: 0, cols: [], newCols: [], goneCols: [], files: [], configChanged: false };
  if (!oldFp) return out;
  out.newCols = headers.filter(function (c) { return oldFp.cols.indexOf(c) < 0; });
  out.goneCols = oldFp.cols.filter(function (c) { return headers.indexOf(c) < 0; });
  out.configChanged = oldFp.config && fp.config && oldFp.config !== fp.config;
  out.files = GRA_filesSince_(oldFp.builtAt);

  var jsonRef = prev.filter(function (x) { return x.part === 'JSON'; })[0];
  if (!jsonRef) return out;
  var old;
  try {
    old = JSON.parse(Utilities.ungzip(DriveApp.getFileById(jsonRef.id).getBlob().setContentType('application/x-gzip')).getDataAsString());
  } catch (e) { return out; }
  var ki = GRA_col_(headers, s.KEY_COLUMN), oki = GRA_col_(old.headers, s.KEY_COLUMN);
  var oldBy = {};
  old.rows.forEach(function (r) { oldBy[GRA_norm_(r[oki])] = r; });
  var shared = headers.filter(function (c) { return old.headers.indexOf(c) >= 0; });
  var idx = shared.map(function (c) { return [headers.indexOf(c), old.headers.indexOf(c)]; });
  var colCount = {}, seen = {};
  rows.forEach(function (r) {
    var k = GRA_norm_(r[ki]), o = oldBy[k];
    seen[k] = 1;
    if (!o) { out.added++; return; }
    var any = false;
    idx.forEach(function (p, j) {
      if (GRA_norm_(r[p[0]]) !== GRA_norm_(o[p[1]])) { any = true; colCount[shared[j]] = (colCount[shared[j]] || 0) + 1; }
    });
    if (any) out.changed++;
  });
  Object.keys(oldBy).forEach(function (k) { if (!seen[k]) out.removed++; });
  out.cols = Object.keys(colCount).sort(function (a, b) { return colCount[b] - colCount[a]; }).slice(0, 8)
    .map(function (c) { return c + ' (' + GRA_fmt_(colCount[c]) + ' GR)'; });
  return out;
}

function GRA_reportChange_(ss, s, h, d, oldFp, fp, urls, noMail) {
  var lines = [], why = [];
  if (!oldFp) {
    lines.push('First archive created: ' + GRA_fmt_(fp.rows) + ' rows.');
  } else {
    if (d.files.length) why.push('files read again: ' + d.files.slice(0, 8).join(', ') + (d.files.length > 8 ? ' +' + (d.files.length - 8) : ''));
    if (d.configChanged) why.push('engine config (SOURCE / COLUMN / JOIN_CONFIG) changed');
    if (d.newCols.length) why.push('new columns: ' + d.newCols.join(', '));
    lines.push('Rows ' + GRA_fmt_(oldFp.rows) + ' → ' + GRA_fmt_(fp.rows) + ' (' + GRA_signed_(fp.rows - oldFp.rows) + ')' +
               ' · new GRs ' + GRA_fmt_(d.added) + ' · removed GRs ' + GRA_fmt_(d.removed) + ' · changed GRs ' + GRA_fmt_(d.changed));
    if (d.goneCols.length) lines.push('Removed columns: ' + d.goneCols.join(', '));
    if (d.cols.length) lines.push('Most changed columns: ' + d.cols.join(', '));
    Object.keys(fp.sums).forEach(function (c) {
      var a = oldFp.sums[c], b = fp.sums[c];
      if (a === undefined) { lines.push(c + ': ' + GRA_fmt_(b) + ' (new)'); return; }
      if (Math.abs(a - b) > 0.005) lines.push(c + ': ' + GRA_fmt_(a) + ' → ' + GRA_fmt_(b) + ' (' + GRA_signed_(b - a) + ')');
    });
  }
  var title = h.label + (oldFp ? ' rebuilt' : ' archive created');
  var sh = ss.getSheetByName(GRA_TAB.changes);
  sh.appendRow([new Date(), h.key, title, why.join('; '), lines.join('\n'), urls.join('\n')]);
  if (!noMail) GRA_mail_(s, 'GR Archive: ' + title,
    '<p><b>' + GRA_esc_(title) + '</b>' + (why.length ? '<br>Why: ' + GRA_esc_(why.join('; ')) : '') + '</p><ul>' +
    lines.map(function (l) { return '<li>' + GRA_esc_(l) + '</li>'; }).join('') + '</ul>' +
    '<p>' + urls.map(function (u, i) { return '<a href="' + u + '">Archive sheet' + (urls.length > 1 ? ' part ' + (i + 1) : '') + '</a>'; }).join(' · ') +
    (oldFp ? (GRA_keepOld_(s) ? ' · the old version stays in GR_ARCHIVE/old for ' + (s.KEEP_OLD_DAYS || 90) + ' days'
                             : ' · this file replaced the old one for the same period (old one in Drive Trash for 30 days)') : '') + '</p>' +
    '<p>No effect on the dashboard: it reads the full engine data.</p>');
}

/** Files the engine re-read after a time (from PROCESS_LOG). */
function GRA_filesSince_(sinceIso) {
  var sh = GRA_engineSs_().getSheetByName('PROCESS_LOG');
  if (!sh || !sinceIso || sh.getLastRow() < 2) return [];
  var v = sh.getDataRange().getValues(), h = v[0].map(String);
  var fi = GRA_col_(h, 'File_Name'), ti = GRA_col_(h, 'Processed_Time');
  if (fi < 0 || ti < 0) return [];
  var since = new Date(sinceIso).getTime(), names = {};
  v.slice(1).forEach(function (r) {
    var t = r[ti] instanceof Date ? r[ti].getTime() : new Date(r[ti]).getTime();
    if (t > since && r[fi]) names[String(r[fi])] = 1;
  });
  return Object.keys(names);
}

function GRA_configHash_() {
  var ss = GRA_engineSs_(), h = 2166136261;
  ['SOURCE_CONFIG', 'COLUMN_CONFIG', 'JOIN_CONFIG'].forEach(function (n) {
    var sh = ss.getSheetByName(n);
    if (sh) h = GRA_fnv_(JSON.stringify(sh.getDataRange().getDisplayValues()), h);
  });
  return (h >>> 0).toString(16);
}

/* ------------------------------------------------------------------ mirror trim */

function GRA_trimMirror_(ss, s, dry) {
  var sh = GRA_mirrorSheet_(ss, s);
  if (!sh || sh.getLastRow() < 2) return 'Mirror tab empty / not found';
  var head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
  var di = GRA_col_(head, s.DATE_COLUMN), ki = GRA_col_(head, s.KEY_COLUMN);
  if (di < 0 || ki < 0) return 'Mirror: ' + s.DATE_COLUMN + ' / ' + s.KEY_COLUMN + ' not found, trim skipped';
  var n = sh.getLastRow() - 1;
  var dates = sh.getRange(2, di + 1, n, 1).getValues(), keys = sh.getRange(2, ki + 1, n, 1).getValues();
  var cutoff = GRA_cutoffIso_(s), keySets = {}, drop = [], notArchived = 0, dropHalves = {};
  for (var r = 0; r < n; r++) {
    var iso = GRA_iso_(dates[r][0]);
    if (!iso || iso >= cutoff) continue;
    var hk = GRA_halfOf_(iso).key;
    if (keySets[hk] === undefined) keySets[hk] = GRA_archivedKeys_(ss, hk);
    if (keySets[hk] && keySets[hk][GRA_norm_(keys[r][0])]) { drop.push(r + 2); dropHalves[hk] = 1; } else notArchived++;
  }
  var refill = dry ? false : GRA_noteRefill_(cutoff, Object.keys(dropHalves));
  var msg = 'Mirror: ' + GRA_fmt_(drop.length) + ' rows older than ' + cutoff + (dry ? ' will be removed' : ' removed') +
            (notArchived ? ', ' + GRA_fmt_(notArchived) + ' older rows kept because they are not in an archive' : '');
  if (refill) {
    msg += ' | ENGINE IS REFILLING THE MIRROR: add the GRA_mirrorFilter hook to the engine';
    GRA_mail_(s, 'GR Archive: the mirror is being refilled',
      '<p>Old rows that were removed from the mirror tab were written back by the engine refresh. Add <code>rows = GRA_mirrorFilter(headers, rows)</code> to the engine code that writes the mirror.</p>');
  }
  if (dry || !drop.length) return msg;
  // the engine also writes this tab: hold its lock only for the few seconds of the delete
  var eng = LockService.getScriptLock();
  if (!eng.tryLock(30000)) return msg.replace(' removed', ' to remove (next run, engine busy)');
  try {
  // delete contiguous runs from the bottom up
  var runs = [], start = drop[0], prev = drop[0];
  for (var i = 1; i <= drop.length; i++) {
    if (i < drop.length && drop[i] === prev + 1) { prev = drop[i]; continue; }
    runs.push([start, prev - start + 1]);
    if (i < drop.length) { start = prev = drop[i]; }
  }
  for (var j = runs.length - 1; j >= 0; j--) sh.deleteRows(runs[j][0], runs[j][1]);
  } finally { eng.releaseLock(); }
  return msg;
}

/** True when rows of a half-year that was already trimmed (same cutoff) show up again (engine refill). */
function GRA_noteRefill_(cutoff, halves) {
  var p = PropertiesService.getScriptProperties();
  var done = JSON.parse(p.getProperty('GRA_TRIMMED') || 'null') || {};
  if (done.cutoff !== cutoff) done = { cutoff: cutoff, halves: [] };
  var again = halves.some(function (h) { return done.halves.indexOf(h) >= 0; });
  halves.forEach(function (h) { if (done.halves.indexOf(h) < 0) done.halves.push(h); });
  p.setProperty('GRA_TRIMMED', JSON.stringify(done));
  return again;
}

function GRA_cutoffIso_(s) {
  var keep = Math.max(1, Number(s.KEEP_MONTHS) || 6), d = new Date();
  var first = new Date(d.getFullYear(), d.getMonth() - (keep - 1), 1);
  return Utilities.formatDate(first, Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

function GRA_archivedHalves_(ss) {
  var out = {};
  GRA_registry_(ss).forEach(function (x) { if (x.status === 'CURRENT') out[x.key] = 1; });
  return out;
}

/**
 * GR NOs of one archived half-year. Read from the KEY column of the verified archive sheet(s) only,
 * not from the JSON copy: opening the whole JSON (every row x every column) for each half-year
 * ran Apps Script out of memory.
 */
function GRA_archivedKeys_(ss, hk) {
  var all = GRA_registry_(ss).filter(function (x) { return x.key === hk && x.status === 'CURRENT'; });
  if (!all.some(function (x) { return x.part === 'JSON'; })) return null;   // not finished / verified yet
  var parts = all.filter(function (x) { return x.part !== 'JSON'; });
  if (!parts.length) return null;
  var keyName = GRA_settings_(ss).KEY_COLUMN, set = {};
  for (var p = 0; p < parts.length; p++) {
    var sh = SpreadsheetApp.openById(parts[p].id).getSheets()[0], n = sh.getLastRow() - 1;
    if (n < 1) continue;
    var ki = GRA_col_(sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String), keyName);
    if (ki < 0) return null;
    var v = sh.getRange(2, ki + 1, n, 1).getValues();
    for (var r = 0; r < n; r++) set[GRA_norm_(v[r][0])] = 1;
  }
  return set;
}

/* ------------------------------------------------------------------ registry, folders, old versions */

/** True while the saved build state is still the one this run started (no other run took over or finished it). */
function GRA_stillMine_(st) {
  var cur = JSON.parse(PropertiesService.getScriptProperties().getProperty(GRA_STATE_KEY) || 'null');
  return !!cur && cur.key === st.key && cur.fileIds.join() === st.fileIds.join();
}

/** Menu (optional): the same self-check every run already does, shown in a box. */
function GRA_checkFiles() {
  var ss = GRA_engineSs_(), s = GRA_settings_(ss);
  var lock = LockService.getDocumentLock() || LockService.getScriptLock();
  if (!lock.tryLock(30000)) { GRA_dialog_('Archive status', 'An archive run is going. It checks itself when it finishes.', ''); return; }
  var r;
  try { r = GRA_heal_(ss, s); } finally { lock.releaseLock(); }
  if (r.rebuild.length) GRA_scheduleContinue_(1);
  GRA_dialog_('Archive status', GRA_statusText_(r), '');
}

/**
 * Self-healing, run at the end of every finished archive run (no click needed). Keeps exactly one complete
 * file set per period: fixes names, puts CURRENT files back in GR_ARCHIVE, removes extra copies, double lines,
 * unfinished "- building" leftovers and (KEEP_OLD_VERSION = NO) everything in old/. A period whose files are
 * missing or whose row count is wrong is cleared so the next run rebuilds it from the engine data.
 */
function GRA_heal_(ss, s) {
  var sh = ss.getSheetByName(GRA_TAB.files), fixes = [], periods = [], rebuild = [];
  var folder = GRA_archiveFolder_(ss, s), oldFolder = GRA_subFolder_(folder, 'old'), keepOld = GRA_keepOld_(s);
  var stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd_HHmm');
  var st = JSON.parse(PropertiesService.getScriptProperties().getProperty(GRA_STATE_KEY) || 'null');
  var live = st ? st.fileIds : [];
  var seenId = {}, byKey = {};
  GRA_registry_(ss).forEach(function (x) {
    if (x.status !== 'CURRENT') return;
    if (seenId[x.id]) { sh.getRange(x.row, 8).setValue('DUPLICATE LINE'); fixes.push(x.key + ': double line removed from ARCHIVE_FILES'); return; }
    seenId[x.id] = 1;
    var f = null;
    try { f = DriveApp.getFileById(x.id); if (f.isTrashed()) f = null; } catch (e) { f = null; }
    if (!f) { sh.getRange(x.row, 8).setValue('MISSING'); return; }
    x.file = f;
    (byKey[x.key] = byKey[x.key] || []).push(x);
  });
  // every period that has data in the engine fingerprints, or files in ARCHIVE_FILES
  var keys = {};
  Object.keys(byKey).forEach(function (k) { keys[k] = 1; });
  PropertiesService.getScriptProperties().getKeys().forEach(function (k) { if (k.indexOf('GRA_FP_') === 0) keys[k.slice(7)] = 1; });
  Object.keys(keys).sort().forEach(function (key) {
    if (st && st.key === key) return;   // being built right now
    var list = byKey[key] || [];
    var newest = list.length ? list.reduce(function (m, x) { return new Date(x.builtAt) > new Date(m) ? x.builtAt : m; }, list[0].builtAt) : null;
    var keep = list.filter(function (x) { return String(x.builtAt) === String(newest); });
    var extraJson = keep.filter(function (x) { return x.part === 'JSON'; }).slice(1);
    list.forEach(function (x) {
      if (keep.indexOf(x) < 0 || extraJson.indexOf(x) >= 0) {
        try { GRA_discard_(x.file, keepOld, oldFolder, ' (extra copy ' + stamp + ')'); } catch (e) {}
        sh.getRange(x.row, 8).setValue('REPLACED extra copy ' + stamp);
        fixes.push(key + ': extra copy removed');
      }
    });
    keep = keep.filter(function (x) { return extraJson.indexOf(x) < 0; });
    var sheets = keep.filter(function (x) { return x.part !== 'JSON'; }), json = keep.filter(function (x) { return x.part === 'JSON'; });
    var rows = 0, files = [];
    sheets.forEach(function (x) {
      var name = x.file.getName().replace(/ \((old|extra copy|unfinished) [^)]*\)/g, '').replace(' - building', '');
      if (name !== x.file.getName()) { x.file.setName(name); fixes.push(key + ': name fixed to ' + name); }
      var inOld = false, it = x.file.getParents();
      while (it.hasNext()) if (it.next().getId() === oldFolder.getId()) inOld = true;
      if (inOld) { x.file.moveTo(folder); fixes.push(key + ': ' + name + ' moved back to GR_ARCHIVE'); }
      try { rows += SpreadsheetApp.openById(x.id).getSheets()[0].getLastRow() - 1; } catch (e) {}
      files.push({ name: name, url: x.file.getUrl() });
    });
    var fp = GRA_storedFp_(key), label = list.length ? list[0].label : GRA_labelOf_(key);
    var ok = !!fp && sheets.length > 0 && json.length === 1 && fp.rows === rows;
    if (!ok) {
      // broken or half-made period: clear it, the next run rebuilds it cleanly from the engine data
      keep.forEach(function (x) { try { x.file.setTrashed(true); } catch (e) {} sh.getRange(x.row, 8).setValue('REPLACED broken ' + stamp); });
      PropertiesService.getScriptProperties().deleteProperty('GRA_FP_' + key);
      rebuild.push(key);
      fixes.push(label + ': incomplete (' + GRA_fmt_(rows) + ' rows' + (fp ? ' of ' + GRA_fmt_(fp.rows) : '') + '), rebuilding it');
    }
    periods.push({ key: key, label: label, ok: ok, rows: rows, files: ok ? files : [] });
  });
  // unfinished leftovers that no run is working on, and the old/ folder
  [folder, oldFolder].forEach(function (fd) {
    var it = fd.getFiles();
    while (it.hasNext()) {
      var f = it.next();
      if (f.isTrashed() || live.indexOf(f.getId()) >= 0 || seenId[f.getId()] && fd === folder) continue;
      var building = f.getName().indexOf(' - building') >= 0;
      if (fd === folder && !building) continue;
      if (fd === oldFolder && keepOld && !building) continue;
      fixes.push((fd === oldFolder ? 'old/' : '') + f.getName() + ': removed');
      f.setTrashed(true);
    }
  });
  if (!keepOld) GRA_registry_(ss).forEach(function (x) { if (x.status.indexOf('OLD') === 0 && x.status.indexOf('TRASHED') < 0) sh.getRange(x.row, 8).setValue(x.status + ' TRASHED'); });
  var r = { periods: periods, fixes: fixes, rebuild: rebuild, building: st };
  GRA_log_(ss, 'CHECK', GRA_statusText_(r).replace(/\n/g, ' | '), '');
  return r;
}

function GRA_labelOf_(key) {
  var m = key.match(/^FY(\d\d)-(\d\d)_H([12])$/);
  if (!m) return key;
  return GRA_halfOf_('20' + m[1] + (m[3] === '1' ? '-04-01' : '-10-01')).label;
}

function GRA_statusText_(r) {
  var t = r.periods.map(function (p) {
    return (p.ok ? 'OK     ' : 'REBUILD ') + p.label + ': ' + GRA_fmt_(p.rows) + ' rows' + (p.files.length ? ' · ' + p.files.map(function (f) { return f.name; }).join(', ') : '');
  });
  if (r.building) t.push('BUILDING ' + GRA_labelOf_(r.building.key) + ': ' + GRA_fmt_(r.building.next) + ' rows written so far');
  if (r.fixes.length) t.push('', 'Fixed: ' + r.fixes.join('; '));
  return t.join('\n') || 'No archive yet.';
}

/** One status mail when everything is archived and clean, and again only when that list changes. */
function GRA_statusMail_(s, r) {
  if (r.building || r.rebuild.length || !r.periods.length) return;
  var sig = JSON.stringify(r.periods.map(function (p) { return [p.key, p.rows, p.files.map(function (f) { return f.url; })]; }));
  var p = PropertiesService.getScriptProperties();
  if (p.getProperty('GRA_STATUS_SIG') === sig) return;
  p.setProperty('GRA_STATUS_SIG', sig);
  var rowsHtml = r.periods.map(function (q) {
    return '<tr><td>' + GRA_esc_(q.label) + '</td><td style="text-align:right">' + GRA_fmt_(q.rows) + '</td><td>' +
      q.files.map(function (f) { return '<a href="' + f.url + '">' + GRA_esc_(f.name) + '</a>'; }).join('<br>') + '</td><td><b>OK</b></td></tr>';
  }).join('');
  GRA_mail_(s, 'GR Archive: all periods archived (' + r.periods.length + ')',
    '<p>Each 6-month period has exactly one archive file in Drive > GR_DASHBOARD_DATA > GR_ARCHIVE:</p>' +
    '<table border="1" cellpadding="5" style="border-collapse:collapse;font:13px Arial"><tr><th>Period</th><th>Rows</th><th>File</th><th>Status</th></tr>' +
    rowsHtml + '</table><p>New periods are archived automatically every night. Nothing to do.</p>');
}

function GRA_registry_(ss) {
  var sh = ss.getSheetByName(GRA_TAB.files);
  if (!sh || sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, 8).getValues().map(function (r, i) {
    return { row: i + 2, key: String(r[0]), label: r[1], part: String(r[2]), id: String(r[3]), url: r[4], rows: r[5], builtAt: r[6], status: String(r[7]) };
  });
}

function GRA_register_(ss, h, part, id, url, rows) {
  ss.getSheetByName(GRA_TAB.files).appendRow([h.key, h.label, part, id, url, rows, new Date(), 'CURRENT']);
}

function GRA_markOld_(ss, key, stamp, word, except) {
  var sh = ss.getSheetByName(GRA_TAB.files);
  GRA_registry_(ss).forEach(function (x) {
    if (x.key === key && x.status === 'CURRENT' && (except || []).indexOf(x.id) < 0) sh.getRange(x.row, 8).setValue((word || 'OLD ') + stamp);
  });
}

function GRA_discard_(f, keepOld, oldFolder, suffix) {
  if (keepOld) { f.setName(f.getName() + suffix); f.moveTo(oldFolder); } else f.setTrashed(true);
}

function GRA_keepOld_(s) { return String(s.KEEP_OLD_VERSION || 'NO').toUpperCase() === 'YES'; }

function GRA_purgeOld_(s) {
  var ss = GRA_engineSs_(), days = GRA_keepOld_(s) ? (Number(s.KEEP_OLD_DAYS) || 90) : 0, limit = Date.now() - days * 864e5;
  var sh = ss.getSheetByName(GRA_TAB.files);
  GRA_registry_(ss).forEach(function (x) {
    if (x.status.indexOf('OLD') !== 0 || x.status.indexOf('TRASHED') >= 0) return;
    if (new Date(x.builtAt).getTime() > limit) return;
    try { DriveApp.getFileById(x.id).setTrashed(true); } catch (e) {}
    sh.getRange(x.row, 8).setValue(x.status + ' TRASHED');
  });
}

function GRA_archiveFolder_(ss, s) {
  var id = GRA_idFrom_(s.ARCHIVE_FOLDER_ID);
  if (id) return folderByIdRestore_(id, 'archive') || DriveApp.getFolderById(id);
  // New archives go in GR_DASHBOARD_DATA (DataFolders.gs), away from the input folders.
  var f = GRA_subFolder_(getDataFolder_(), 'GR_ARCHIVE');
  GRA_setSetting_(ss, 'ARCHIVE_FOLDER_ID', f.getId());
  return f;
}

function GRA_subFolder_(parent, name) {
  var it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

function GRA_storedFp_(key) {
  return JSON.parse(PropertiesService.getScriptProperties().getProperty('GRA_FP_' + key) || 'null');
}

/* ------------------------------------------------------------------ continuation trigger */

/** Installs the nightly trigger if it is missing, so every finished half-year is archived without a click. */
function GRA_ensureNightly_() {
  if (ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'GRA_nightly'; })) return;
  var s = GRA_settings_(GRA_engineSs_());
  ScriptApp.newTrigger('GRA_nightly').timeBased().everyDays(1).atHour(Number(s.RUN_HOUR) || 2).create();
}

function GRA_scheduleContinue_(minutes) {
  GRA_clearContinue_();
  ScriptApp.newTrigger('GRA_continue').timeBased().after((minutes || 1) * 60 * 1000).create();
}

/** The engine is mid-refresh: its lock is held, or it has a continuation queued for new / changed files. */
function GRA_engineBusy_() {
  if (ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'continueRefresh'; })) return true;
  var l = LockService.getScriptLock();
  if (!l.tryLock(1000)) return true;
  l.releaseLock();
  return false;
}

function GRA_clearContinue_() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'GRA_continue') ScriptApp.deleteTrigger(t); });
}

/* ------------------------------------------------------------------ settings and tabs */

function GRA_engineSs_() {
  var ss = null;
  try { ss = SpreadsheetApp.getActive(); } catch (e) {}
  if (ss) return ss;
  var id = PropertiesService.getScriptProperties().getProperty('GRA_ENGINE_SHEET_ID');
  if (!id) throw new Error('Script is not bound to the engine sheet: set script property GRA_ENGINE_SHEET_ID');
  return SpreadsheetApp.openById(id);
}

function GRA_ensureTabs_(ss) {
  var make = function (name, header, widths) {
    var sh = ss.getSheetByName(name);
    if (sh) return sh;
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold');
    sh.setFrozenRows(1);
    (widths || []).forEach(function (w, i) { sh.setColumnWidth(i + 1, w); });
    if (sh.getMaxColumns() > header.length) sh.deleteColumns(header.length + 1, sh.getMaxColumns() - header.length);
    if (sh.getMaxRows() > 200) sh.deleteRows(201, sh.getMaxRows() - 200);
    return sh;
  };
  var st = make(GRA_TAB.settings, ['Setting', 'Value', 'Meaning'], [170, 220, 560]);
  var have = st.getLastRow() > 1 ? st.getRange(2, 1, st.getLastRow() - 1, 1).getValues().map(function (r) { return String(r[0]); }) : [];
  GRA_DEFAULTS.forEach(function (d) { if (have.indexOf(d[0]) < 0) st.appendRow(d); });
  // keep the header and the Meaning column in English (values the owner typed are not touched)
  st.getRange(1, 3).setValue('Meaning');
  if (st.getLastRow() > 1) {
    var keys = st.getRange(2, 1, st.getLastRow() - 1, 1).getValues();
    keys.forEach(function (r, i) { var d = GRA_DEFAULTS.filter(function (x) { return x[0] === String(r[0]); })[0]; if (d) st.getRange(i + 2, 3).setValue(d[2]); });
  }
  make(GRA_TAB.log, ['When', 'Type', 'What happened', 'Time taken'], [150, 80, 760, 90]);
  make(GRA_TAB.changes, ['When', 'Half-year', 'What', 'Why', 'Old vs new', 'Archive link'], [150, 110, 240, 320, 520, 300]);
  make(GRA_TAB.files, ['Half-year', 'Label', 'Part', 'File ID', 'Link', 'Rows', 'Built at', 'Status'], [110, 230, 90, 120, 300, 80, 150, 160]);
}

function GRA_settings_(ss) {
  var out = {};
  GRA_DEFAULTS.forEach(function (d) { out[d[0]] = d[1]; });
  var sh = ss.getSheetByName(GRA_TAB.settings);
  if (sh && sh.getLastRow() > 1) {
    sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues().forEach(function (r) {
      var k = String(r[0]).trim();
      if (k && String(r[1]).trim() !== '') out[k] = String(r[1]).trim();
    });
  }
  return out;
}

function GRA_setSetting_(ss, key, value) {
  var sh = ss.getSheetByName(GRA_TAB.settings), v = sh.getRange(2, 1, Math.max(1, sh.getLastRow() - 1), 1).getValues();
  for (var i = 0; i < v.length; i++) if (String(v[i][0]) === key) { sh.getRange(i + 2, 2).setValue(value); return; }
  sh.appendRow([key, value, '']);
}

function GRA_mirrorId_(s) {
  return GRA_idFrom_(s.MIRROR_SHEET) || (typeof MIRROR_FILE_ID !== 'undefined' ? MIRROR_FILE_ID : '');
}

function GRA_mirrorSheet_(ss, s) {
  var id = GRA_mirrorId_(s);
  var book = id && id !== ss.getId() ? SpreadsheetApp.openById(id) : ss;
  var tab = String(s.MIRROR_TAB || (typeof MIRROR_SHEET_NAME !== 'undefined' ? MIRROR_SHEET_NAME : 'DASHBOARD_MASTER')).trim();
  return book.getSheetByName(tab);
}

function GRA_log_(ss, type, text, took) {
  var sh = ss.getSheetByName(GRA_TAB.log);
  if (!sh) return;
  sh.appendRow([new Date(), type, String(text).slice(0, 49000), took]);
  if (sh.getLastRow() > 1200) sh.deleteRows(2, 200);   // keep the log small
}

function GRA_mail_(s, subject, html) {
  var to = String(s.ALERT_EMAILS || '').trim() || Session.getEffectiveUser().getEmail();
  if (!to) return;
  MailApp.sendEmail({ to: to, subject: subject, htmlBody: html });
}

/* ------------------------------------------------------------------ small helpers */

/** Same sheet view as the engine's DASHBOARD_MASTER (dates as dates, Ton / Lacs, number formats). */
function GRA_view_(master) {
  var h = master.headers, v = master.sheetView || { divisors: {}, formats: {} };
  var useUnits = typeof SETTINGS === 'undefined' || SETTINGS.SHEET_VIEW_UNITS !== false;
  return {
    dateIdx: (master.dateColumns || []).map(function (c) { return h.indexOf(c); }).filter(function (i) { return i >= 0; }),
    divIdx: useUnits ? Object.keys(v.divisors || {}).map(function (c) { return [h.indexOf(c), v.divisors[c]]; }).filter(function (p) { return p[0] >= 0; }) : [],
    formats: Object.keys(v.formats || {}).map(function (c) { return [h.indexOf(c), String(v.formats[c])]; }).filter(function (p) { return p[0] >= 0; })
  };
}

function GRA_toDate_(v) {
  if (typeof isoToDate_ === 'function') return isoToDate_(v);
  var iso = GRA_iso_(v);
  return iso ? new Date(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))) : v;
}

function GRA_col_(headers, name) {
  var n = function (x) { return String(x).toLowerCase().replace(/[^a-z0-9]/g, ''); };
  var want = n(name);
  for (var i = 0; i < headers.length; i++) if (n(headers[i]) === want) return i;
  return -1;
}

function GRA_iso_(v) {
  if (v instanceof Date) return isNaN(v) ? '' : Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  var t = String(v == null ? '' : v).trim();
  var m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return m[1] + '-' + m[2] + '-' + m[3];
  m = t.match(/^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{4})/);   // Indian dd-mm-yyyy
  if (m) return m[3] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[1]).slice(-2);
  return '';
}

function GRA_norm_(v) {
  if (v instanceof Date) return GRA_iso_(v);
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return String(Math.round(v * 1e6) / 1e6);
  var t = String(v).trim();
  if (/^-?\d+(\.\d+)?$/.test(t)) return String(Math.round(Number(t) * 1e6) / 1e6);
  return t;
}

function GRA_fnv_(str, seed) {
  var h = seed === undefined ? 2166136261 : seed;
  for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

function GRA_todayIso_() { return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd'); }
function GRA_idFrom_(v) { var m = String(v || '').match(/[-\w]{25,}/); return m ? m[0] : ''; }
function GRA_fmt_(n) { return Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 }); }
function GRA_signed_(n) { return (n > 0 ? '+' : '') + GRA_fmt_(n); }
function GRA_esc_(t) { return String(t).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
