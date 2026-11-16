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
  ['ARCHIVE_ON', 'YES', 'YES = archives bante hain aur mirror trim hota hai. NO = sirf check + report (dry run), kuch nahi badalta.'],
  ['KEEP_MONTHS', '6', 'Mirror tab me kitne mahine rakhne hain (is mahine samet). Purani rows tabhi hatengi jab unka archive verify ho chuka ho.'],
  ['MIRROR_TAB', 'DASHBOARD_MASTER', 'Mirror tab ka naam'],
  ['MIRROR_SHEET', '', 'Mirror alag spreadsheet me hai to uska link / ID. Khali = yahi spreadsheet.'],
  ['DATE_COLUMN', 'GR DT', 'Date column (half-year isi se banta hai)'],
  ['KEY_COLUMN', 'GR NO', 'Har row ki unique key'],
  ['SUM_COLUMNS', 'TOTAL FREIGHT, TOTAL EXPENSE, CWEIGHT, AWEIGHT, BASIC FREIGHT', 'Change mail me in columns ka total old vs new dikhega'],
  ['ARCHIVE_FOLDER_ID', '', 'Archive ka Drive folder ID. Khali = is spreadsheet ke folder me GR_ARCHIVE apne aap banega.'],
  ['KEEP_OLD_DAYS', '90', 'Purana archive version kitne din GR_ARCHIVE/old me rahe'],
  ['WARN_PCT', '70', 'Cells itne % bharne pe mail'],
  ['URGENT_PCT', '85', 'Cells itne % bharne pe URGENT mail'],
  ['ALERT_EMAILS', '', 'Mail kisko jaaye (comma se alag). Khali = script owner.'],
  ['RUN_HOUR', '2', 'Roz kitne baje chale (0-23). Badalne ke baad GRA_setup dobara chalao.'],
  ['ARCHIVE_MAX_CELLS', '9000000', 'Ek archive sheet me max cells; isse zyada ho to Part 2 banega']
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
function GRA_runNow() { GRA_run_(false); }
function GRA_dryRun() { GRA_run_(true); }

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

/* ------------------------------------------------------------------ main run */

function GRA_run_(dry) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return;
  var t0 = Date.now(), ss = GRA_engineSs_();
  try {
    GRA_ensureTabs_(ss);
    var s = GRA_settings_(ss);
    if (String(s.ARCHIVE_ON).toUpperCase() !== 'YES') dry = true;
    var notes = [];

    var size = GRA_checkSize_(ss, s);
    notes.push(size.text);

    var master = GRA_readMaster_(ss, s);
    var halves = GRA_groupHalves_(master, s);
    var done = true;
    for (var i = 0; i < halves.length; i++) {
      var h = halves[i];
      if (!h.complete) continue;
      var fp = GRA_fingerprint_(master.headers, h.rows, s);
      var old = GRA_storedFp_(h.key);
      if (old && old.hash === fp.hash) continue;
      if (dry) { notes.push(h.label + ': ' + (old ? 'data badla, rebuild hoga' : 'archive banega') + ' (' + h.rows.length + ' rows)'); continue; }
      var res = GRA_buildHalf_(ss, s, master, h, fp, old, t0);
      if (res === 'timeout') { done = false; break; }
      notes.push(res);
    }

    if (done) {
      GRA_clearContinue_();
      var trim = GRA_trimMirror_(ss, s, dry);
      notes.push(trim);
      if (!dry) GRA_purgeOld_(s);
    } else {
      GRA_scheduleContinue_();
      notes.push('Time khatam, 1 min me apne aap aage chalega');
    }
    GRA_log_(ss, dry ? 'DRY RUN' : 'RUN', notes.filter(String).join(' | '), Math.round((Date.now() - t0) / 1000) + ' s');
  } catch (err) {
    GRA_log_(ss, 'ERROR', String(err && err.stack || err), '');
    GRA_mail_(GRA_settings_(ss), 'GR Archive: ERROR', '<p>Archive run fail hua. Kuch delete nahi hua.</p><pre>' + GRA_esc_(String(err && err.stack || err)) + '</pre>');
  } finally {
    lock.releaseLock();
  }
}

/* ------------------------------------------------------------------ size guard */

function GRA_checkSize_(ss, s) {
  var books = [ss], mid = GRA_idFrom_(s.MIRROR_SHEET);
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
    parts.push(b.getName() + ': ' + GRA_fmt_(cells) + ' cells (' + pct.toFixed(1) + '%), sabse bada tab ' + biggest);
    if (!worst || pct > worst.pct) worst = { pct: pct, cells: cells, name: b.getName(), url: b.getUrl(), biggest: biggest };
  });
  var warn = Number(s.WARN_PCT) || 70, urgent = Number(s.URGENT_PCT) || 85;
  if (worst.pct >= warn) {
    var lvl = worst.pct >= urgent ? 'URGENT' : 'Warning';
    GRA_mail_(s, 'GR sheet ' + lvl + ': ' + worst.pct.toFixed(1) + '% bhar gayi',
      '<p><b>' + GRA_esc_(worst.name) + '</b> me ' + GRA_fmt_(worst.cells) + ' cells hain, Google ki limit 1,00,00,000 ka <b>' +
      worst.pct.toFixed(1) + '%</b>. Sabse bada tab: ' + GRA_esc_(worst.biggest) + '.</p>' +
      '<p>Archive apne aap purane half-year hata raha hai. Agar ye mail roz aa raha hai to ARCHIVE_SETTINGS me KEEP_MONTHS kam karo, ya engine ka mirror hook check karo.</p>' +
      '<p><a href="' + worst.url + '">Sheet kholo</a></p>');
  }
  return parts.join('; ');
}

/* ------------------------------------------------------------------ read the master */

/** Engine master via liveApi (same project). Falls back to the mirror tab when liveApi is not there. */
function GRA_readMaster_(ss, s) {
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
    (by[h.key] = by[h.key] || { key: h.key, label: h.label, start: h.start, end: h.end, rows: [] }).rows.push(r);
  });
  return Object.keys(by).sort().map(function (k) {
    var h = by[k];
    h.complete = h.end < today;
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

  while (st.next < h.rows.length) {
    if (Date.now() - t0 > GRA_TIME_BUDGET_MS) return 'timeout';
    var part = Math.floor(st.next / st.perPart), inPart = st.next - part * st.perPart;
    var take = Math.min(GRA_CHUNK_ROWS, st.perPart - inPart, h.rows.length - st.next);
    var chunk = h.rows.slice(st.next, st.next + take).map(function (r) {
      var row = r.slice(0, cols); while (row.length < cols) row.push('');
      return row.map(function (v) { return v === null || v === undefined ? '' : v; });
    });
    SpreadsheetApp.openById(st.fileIds[part]).getSheets()[0].getRange(inPart + 2, 1, take, cols).setValues(chunk);
    st.next += take;
    props.setProperty(GRA_STATE_KEY, JSON.stringify(st));
  }

  // verify: row count + every key and date read back from the sheets
  var di = GRA_col_(master.headers, s.DATE_COLUMN), ki = GRA_col_(master.headers, s.KEY_COLUMN);
  for (var q = 0; q < st.fileIds.length; q++) {
    var want = h.rows.slice(q * st.perPart, (q + 1) * st.perPart);
    var vs = SpreadsheetApp.openById(st.fileIds[q]).getSheets()[0];
    var got = vs.getLastRow() - 1;
    if (got !== want.length) return GRA_failBuild_(ss, s, h, st, 'Part ' + (q + 1) + ': ' + got + ' rows, chahiye ' + want.length);
    var kv = vs.getRange(2, ki + 1, got, 1).getValues(), dv = vs.getRange(2, di + 1, got, 1).getValues();
    for (var r = 0; r < got; r++) {
      if (GRA_norm_(kv[r][0]) !== GRA_norm_(want[r][ki]) || GRA_iso_(dv[r][0]) !== GRA_iso_(want[r][di])) {
        return GRA_failBuild_(ss, s, h, st, 'Part ' + (q + 1) + ' row ' + (r + 2) + ' match nahi hua');
      }
    }
  }

  // JSON copy (also what the next rebuild compares against)
  var folder2 = GRA_archiveFolder_(ss, s);
  var json = JSON.stringify({ key: h.key, label: h.label, builtAt: new Date().toISOString(), source: master.source,
                              headers: master.headers, rows: h.rows, fingerprint: fp });
  var gz = Utilities.gzip(Utilities.newBlob(json, 'application/json'), 'GR_MASTER_' + h.key + '.json.gz');
  var jsonFile = folder2.createFile(gz);

  // compare with the previous version, then move it to old/
  var prev = GRA_registry_(ss).filter(function (x) { return x.key === h.key && x.status === 'CURRENT'; });
  var diff = GRA_diff_(prev, master.headers, h.rows, s, oldFp, fp);
  var oldFolder = GRA_subFolder_(folder2, 'old'), stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd_HHmm');
  prev.forEach(function (x) {
    try { var f = DriveApp.getFileById(x.id); f.setName(f.getName() + ' (old ' + stamp + ')'); f.moveTo(oldFolder); } catch (e) {}
  });
  GRA_markOld_(ss, h.key, stamp);

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

  GRA_reportChange_(ss, s, h, diff, oldFp, fp, urls);
  return h.label + ': archive ' + (oldFp ? 'dobara bana' : 'bana') + ' (' + h.rows.length + ' rows, verified)';
}

function GRA_failBuild_(ss, s, h, st, why) {
  st.fileIds.forEach(function (id) { try { DriveApp.getFileById(id).setTrashed(true); } catch (e) {} });
  PropertiesService.getScriptProperties().deleteProperty(GRA_STATE_KEY);
  GRA_mail_(s, 'GR Archive: ' + h.label + ' verify fail', '<p>Archive copy check me fail hua: ' + GRA_esc_(why) +
    '.</p><p>Kuch delete nahi hua, mirror tab waisa hi hai. Agli raat dobara try hoga.</p>');
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

function GRA_reportChange_(ss, s, h, d, oldFp, fp, urls) {
  var lines = [], why = [];
  if (!oldFp) {
    lines.push('Pehli baar archive bana: ' + GRA_fmt_(fp.rows) + ' rows.');
  } else {
    if (d.files.length) why.push('files dobara padhi gayi: ' + d.files.slice(0, 8).join(', ') + (d.files.length > 8 ? ' +' + (d.files.length - 8) : ''));
    if (d.configChanged) why.push('engine config (SOURCE / COLUMN / JOIN_CONFIG) badla');
    if (d.newCols.length) why.push('naye columns: ' + d.newCols.join(', '));
    lines.push('Rows ' + GRA_fmt_(oldFp.rows) + ' → ' + GRA_fmt_(fp.rows) + ' (' + GRA_signed_(fp.rows - oldFp.rows) + ')' +
               ' · naye GR ' + GRA_fmt_(d.added) + ' · hate GR ' + GRA_fmt_(d.removed) + ' · badle GR ' + GRA_fmt_(d.changed));
    if (d.goneCols.length) lines.push('Hate columns: ' + d.goneCols.join(', '));
    if (d.cols.length) lines.push('Sabse zyada badle columns: ' + d.cols.join(', '));
    Object.keys(fp.sums).forEach(function (c) {
      var a = oldFp.sums[c], b = fp.sums[c];
      if (a === undefined) { lines.push(c + ': ' + GRA_fmt_(b) + ' (naya)'); return; }
      if (Math.abs(a - b) > 0.005) lines.push(c + ': ' + GRA_fmt_(a) + ' → ' + GRA_fmt_(b) + ' (' + GRA_signed_(b - a) + ')');
    });
  }
  var title = h.label + (oldFp ? ' dobara bana' : ' archive bana');
  var sh = ss.getSheetByName(GRA_TAB.changes);
  sh.appendRow([new Date(), h.key, title, why.join('; '), lines.join('\n'), urls.join('\n')]);
  GRA_mail_(s, 'GR Archive: ' + title,
    '<p><b>' + GRA_esc_(title) + '</b>' + (why.length ? '<br>Wajah: ' + GRA_esc_(why.join('; ')) : '') + '</p><ul>' +
    lines.map(function (l) { return '<li>' + GRA_esc_(l) + '</li>'; }).join('') + '</ul>' +
    '<p>' + urls.map(function (u, i) { return '<a href="' + u + '">Archive sheet' + (urls.length > 1 ? ' part ' + (i + 1) : '') + '</a>'; }).join(' · ') +
    (oldFp ? ' · purana version GR_ARCHIVE/old me ' + (s.KEEP_OLD_DAYS || 90) + ' din rahega' : '') + '</p>' +
    '<p>Dashboard pe koi asar nahi: woh engine ka poora data padhta hai.</p>');
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
  if (!sh || sh.getLastRow() < 2) return 'Mirror tab khali / nahi mila';
  var head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
  var di = GRA_col_(head, s.DATE_COLUMN), ki = GRA_col_(head, s.KEY_COLUMN);
  if (di < 0 || ki < 0) return 'Mirror me ' + s.DATE_COLUMN + ' / ' + s.KEY_COLUMN + ' nahi mila, trim skip';
  var n = sh.getLastRow() - 1;
  var dates = sh.getRange(2, di + 1, n, 1).getValues(), keys = sh.getRange(2, ki + 1, n, 1).getValues();
  var cutoff = GRA_cutoffIso_(s), keySets = {}, drop = [], notArchived = 0;
  for (var r = 0; r < n; r++) {
    var iso = GRA_iso_(dates[r][0]);
    if (!iso || iso >= cutoff) continue;
    var hk = GRA_halfOf_(iso).key;
    if (keySets[hk] === undefined) keySets[hk] = GRA_archivedKeys_(ss, hk);
    if (keySets[hk] && keySets[hk][GRA_norm_(keys[r][0])]) drop.push(r + 2); else notArchived++;
  }
  var refill = dry ? false : GRA_noteRefill_(cutoff, drop.length);
  var msg = 'Mirror: ' + GRA_fmt_(drop.length) + ' rows ' + cutoff + ' se purani' + (dry ? ' hategi' : ' hati') +
            (notArchived ? ', ' + GRA_fmt_(notArchived) + ' purani rows archive me nahi mili isliye rakhi' : '');
  if (refill) {
    msg += ' | ENGINE MIRROR WAPAS BHAR RAHA HAI: engine me GRA_mirrorFilter hook lagana hai';
    GRA_mail_(s, 'GR Archive: mirror wapas bhar raha hai',
      '<p>Jo purani rows mirror tab se hata di thi, engine refresh ne wapas likh di. Engine ke mirror likhne wale code me <code>rows = GRA_mirrorFilter(headers, rows)</code> lagana hai.</p>');
  }
  if (dry || !drop.length) return msg;
  // delete contiguous runs from the bottom up
  var runs = [], start = drop[0], prev = drop[0];
  for (var i = 1; i <= drop.length; i++) {
    if (i < drop.length && drop[i] === prev + 1) { prev = drop[i]; continue; }
    runs.push([start, prev - start + 1]);
    if (i < drop.length) { start = prev = drop[i]; }
  }
  for (var j = runs.length - 1; j >= 0; j--) sh.deleteRows(runs[j][0], runs[j][1]);
  return msg;
}

function GRA_noteRefill_(cutoff, count) {
  var p = PropertiesService.getScriptProperties(), last = JSON.parse(p.getProperty('GRA_LAST_TRIM') || 'null');
  p.setProperty('GRA_LAST_TRIM', JSON.stringify({ cutoff: cutoff, count: count, at: new Date().toISOString() }));
  return !!(last && last.cutoff === cutoff && last.count > 0 && count > 0);
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

function GRA_archivedKeys_(ss, hk) {
  var ref = GRA_registry_(ss).filter(function (x) { return x.key === hk && x.status === 'CURRENT' && x.part === 'JSON'; })[0];
  if (!ref) return null;
  var d = JSON.parse(Utilities.ungzip(DriveApp.getFileById(ref.id).getBlob().setContentType('application/x-gzip')).getDataAsString());
  var ki = GRA_col_(d.headers, GRA_settings_(ss).KEY_COLUMN), set = {};
  d.rows.forEach(function (r) { set[GRA_norm_(r[ki])] = 1; });
  return set;
}

/* ------------------------------------------------------------------ registry, folders, old versions */

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

function GRA_markOld_(ss, key, stamp) {
  var sh = ss.getSheetByName(GRA_TAB.files);
  GRA_registry_(ss).forEach(function (x) {
    if (x.key === key && x.status === 'CURRENT') sh.getRange(x.row, 8).setValue('OLD ' + stamp);
  });
}

function GRA_purgeOld_(s) {
  var ss = GRA_engineSs_(), days = Number(s.KEEP_OLD_DAYS) || 90, limit = Date.now() - days * 864e5;
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
  if (id) return DriveApp.getFolderById(id);
  var parents = DriveApp.getFileById(ss.getId()).getParents();
  var base = parents.hasNext() ? parents.next() : DriveApp.getRootFolder();
  var f = GRA_subFolder_(base, 'GR_ARCHIVE');
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

function GRA_scheduleContinue_() {
  GRA_clearContinue_();
  ScriptApp.newTrigger('GRA_continue').timeBased().after(60 * 1000).create();
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
  var st = make(GRA_TAB.settings, ['Setting', 'Value', 'Matlab'], [170, 220, 560]);
  var have = st.getLastRow() > 1 ? st.getRange(2, 1, st.getLastRow() - 1, 1).getValues().map(function (r) { return String(r[0]); }) : [];
  GRA_DEFAULTS.forEach(function (d) { if (have.indexOf(d[0]) < 0) st.appendRow(d); });
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

function GRA_mirrorSheet_(ss, s) {
  var id = GRA_idFrom_(s.MIRROR_SHEET);
  var book = id && id !== ss.getId() ? SpreadsheetApp.openById(id) : ss;
  return book.getSheetByName(String(s.MIRROR_TAB || 'DASHBOARD_MASTER').trim());
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
