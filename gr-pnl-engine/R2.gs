/**
 * Cloudflare R2: a copy of every verified half-year archive, for the dashboard website.
 *
 * Archive.gs builds each finished half-year (Drive sheet + gzip JSON, verified). R2 is written only from the menu
 * (Archive > Cloudflare R2: move ready half-years now): GRA_r2Sync_ sends each CURRENT gzip JSON of a half-year that
 * ended FREEZE_AFTER_DAYS (45) days ago or more and that R2 does not have yet (or has an older version of), plus a small index:
 *     archive/GR_MASTER_FY25-26_H1.json.gz
 *     archive/index.json      { updatedAt, periods: { FY25-26_H1: { label, start, end, rows, hash, bytes, at } } }
 * The website (Cloudflare Pages, function /archive/...) reads them from the same bucket. The bucket is never
 * public: the website checks the sign-in first.
 *
 * Freeze (FREEZE_ON = YES in ARCHIVE_SETTINGS), done by the same menu item right after the upload: a half-year that
 * is archived, verified and in R2 with the same data leaves the engine. The engine stops reading its rows (and the
 * source files that hold only those months), so every refresh works on the running months only. The website reads
 * the frozen half-years from R2 by itself. The nightly archive run never writes R2: it mails once when a half-year
 * is ready to move. A source file that changes rows of a frozen half-year is not applied; a mail says so, and the
 * owner takes that half-year back (menu), lets the refresh + archive run, and moves it again.
 *
 * Keys live in Script Properties only (never in the code or the repo):
 *   R2_ACCOUNT_ID, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
 * Menu: GR PNL Engine > Archive (6 months) > Cloudflare R2: save keys / test / upload now.
 * Without keys nothing here runs and the archive works exactly as before (Drive only).
 *
 * Upload = one signed S3 PUT (AWS Signature V4, region "auto"), no extra library.
 */

var R2_PREFIX = 'archive/';
var R2_MAX_BYTES = 48 * 1024 * 1024;   // UrlFetchApp sends at most 50 MB in one request
var R2_PROPS = ['R2_ACCOUNT_ID', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'];

/* ------------------------------------------------------------------ menu */

/** Menu: asks for the four values and keeps them in Script Properties. Blank answer = keep the current value. */
function R2_saveKeys() {
  var ui = SpreadsheetApp.getUi(), p = PropertiesService.getScriptProperties();
  var asks = [
    ['R2_ACCOUNT_ID', 'Account ID, or the S3 endpoint shown with the token\n(https://<account id>.r2.cloudflarestorage.com)', false],
    ['R2_BUCKET', 'Bucket name (for example gr-archive)', false],
    ['R2_ACCESS_KEY_ID', 'Access Key ID (from the R2 API token)', true],
    ['R2_SECRET_ACCESS_KEY', 'Secret Access Key (from the R2 API token)', true]
  ];
  for (var i = 0; i < asks.length; i++) {
    var name = asks[i][0], cur = p.getProperty(name) || '';
    var shown = cur ? (asks[i][2] ? ' (saved, ends with ...' + cur.slice(-4) + ')' : ' (now: ' + cur + ')') : '';
    var r = ui.prompt('Cloudflare R2 (' + (i + 1) + ' of 4)', asks[i][1] + shown + '\n\nLeave blank to keep the current value.', ui.ButtonSet.OK_CANCEL);
    if (r.getSelectedButton() !== ui.Button.OK) return;
    var v = String(r.getResponseText() || '').trim();
    if (!v) continue;
    if (name === 'R2_ACCOUNT_ID') { var m = v.match(/([0-9a-f]{32})/i); if (m) v = m[1].toLowerCase(); }
    p.setProperty(name, v);
  }
  R2_test();
}

/** Menu: writes, reads back and deletes a small test file. */
function R2_test() {
  var msg;
  try {
    var c = R2_cfg_();
    if (!c) throw new Error('Keys missing: ' + R2_missing_().join(', ') + '. Use "Cloudflare R2: save keys".');
    var key = R2_PREFIX + '_test.txt', text = 'GR archive test ' + new Date().toISOString();
    R2_put_(c, key, Utilities.newBlob(text, 'text/plain'));
    var back = R2_req_(c, 'GET', key, null);
    if (back.getResponseCode() !== 200 || back.getContentText() !== text) throw new Error('Read back failed (HTTP ' + back.getResponseCode() + ')');
    R2_req_(c, 'DELETE', key, null);
    msg = 'R2 works: bucket "' + c.bucket + '" can be written and read.\n\nThe archive copies itself to R2 at the end of every archive run. ' +
          'To send the existing half-years now: Archive (6 months) > Cloudflare R2: upload archive now.';
  } catch (e) {
    msg = 'R2 test failed: ' + String(e && e.message || e) + '\n\nCheck the account ID, bucket name and that the token has "Object Read & Write" on this bucket.';
  }
  try { GRA_log_(GRA_engineSs_(), 'R2 TEST', msg.split('\n')[0], ''); } catch (e) {}
  try { GRA_dialog_('Cloudflare R2', msg, ''); } catch (e) { Logger.log(msg); }
  return msg;
}

/**
 * Menu (the only way R2 is written): sends every ready half-year (ended FREEZE_AFTER_DAYS days ago, archived and
 * verified) that R2 does not have yet or has an older version of, then freezes the ones R2 now has with the same data.
 */
function R2_uploadNow() {
  var ss = GRA_engineSs_(), s = GRA_settings_(ss), t0, text;
  if (GRA_engineBusy_()) { GRA_dialog_('Cloudflare R2', 'The engine refresh is still working. Try again in a few minutes.', ''); return; }
  // 1. the archive is checked against the engine data of right now (a file changed after the nightly run is archived first)
  var start = Date.now(), arc = GRA_run_(false, true);
  if (/^Error:/.test(arc.text || '')) { GRA_dialog_('Cloudflare R2', 'The archive check failed, nothing was uploaded or frozen:\n\n' + arc.text, ''); return; }
  if (!arc.busy && !arc.building && Date.now() - start > 4 * 60 * 1000) {
    GRA_dialog_('Cloudflare R2', 'The archive is now up to date with the engine data (that took ' + Math.round((Date.now() - start) / 1000) +
      ' s). Click "move ready half-years now" once more to upload and freeze (Apps Script allows 6 minutes per click).', '');
    return;
  }
  if (arc.busy || arc.building) {
    GRA_dialog_('Cloudflare R2', 'The archive is being updated with the latest engine data first:\n\n' + arc.text +
      '\n\nClick "move ready half-years now" again when ARCHIVE_LOG shows the run is finished. Nothing was uploaded or frozen.', '');
    return;
  }
  t0 = Date.now();
  var lock = LockService.getDocumentLock() || LockService.getScriptLock();
  if (!lock.tryLock(30000)) { GRA_dialog_('Cloudflare R2', 'An archive run is going. Try again when it has finished (see ARCHIVE_LOG).', ''); return; }
  try {
    var heal = GRA_heal_(ss, s);
    if (heal.rebuild.length) text = 'The archive is rebuilding ' + heal.rebuild.join(', ') + ' first. Try again after the next archive run.';
    else {
      text = GRA_r2Sync_(ss, s, t0, true) || 'R2 keys are not saved yet.';
      var fr = GRA_freeze_(ss, s, heal);
      text += fr ? '\n\n' + fr + '\nThe engine rebuilds without these months in about 1 minute.' : '';
    }
    GRA_log_(ss, 'R2 MOVE', text.replace(/\n+/g, ' | '), Math.round((Date.now() - t0) / 1000) + ' s');
  } finally { lock.releaseLock(); }
  GRA_dialog_('Cloudflare R2', text, '');
}

/* ------------------------------------------------------------------ archive hook */

/**
 * Called at the end of every finished archive run (Archive.gs GRA_run_). Uploads each CURRENT half-year
 * JSON of a half-year that is ready for R2 (R2_readyHalf_) whose R2 copy is missing or older, then rewrites archive/index.json. Returns a line for the log.
 * Never throws: a failed upload is logged and mailed, the Drive archive is not touched.
 */
function GRA_r2Sync_(ss, s, t0, force) {
  var c = R2_cfg_();
  if (!c) return '';
  var p = PropertiesService.getScriptProperties(), sent = [], failed = [], waiting = 0, current = {};
  GRA_registry_(ss).forEach(function (x) { if (x.status === 'CURRENT' && x.part === 'JSON' && R2_readyHalf_(x.key, s)) current[x.key] = x; });
  var keys = Object.keys(current).sort();   // oldest first (FY25-26 H1, H2, FY26-27 H1, ...); the running half-year is not sent
  for (var i = 0; i < keys.length; i++) {
    var key = keys[i], fp = GRA_storedFp_(key);
    if (!fp) continue;
    var meta = JSON.parse(p.getProperty('GRA_R2_' + key) || 'null');
    if (meta && meta.hash === fp.hash && !force) continue;
    if (meta && meta.hash === fp.hash && force) { try { if (R2_exists_(c, R2_fileKey_(key))) continue; } catch (e) { /* not sure: send it again */ } }
    if (sent.length && Date.now() - t0 > GRA_TIME_BUDGET_MS) { waiting++; continue; }
    try {
      var file = DriveApp.getFileById(current[key].id), bytes = file.getSize();   // size from Drive, the bytes are not read into memory
      if (bytes > R2_MAX_BYTES) throw new Error('file is ' + Math.round(bytes / 1048576) + ' MB, above the 48 MB upload limit');
      R2_put_(c, R2_fileKey_(key), file.getBlob().setContentType('application/gzip'));
      var h = GRA_halfOf_(GRA_labelStart_(key));
      p.setProperty('GRA_R2_' + key, JSON.stringify({ hash: fp.hash, rows: fp.rows, bytes: bytes, at: new Date().toISOString(),
        label: h.label, start: h.start, end: h.end }));
      sent.push(key);
    } catch (e) {
      failed.push(key + ' (' + String(e && e.message || e).slice(0, 200) + ')');
    }
  }
  var out = [];
  var listed = keys.join(',');   // the index is also rewritten when the list of periods changes (e.g. a FY moved out)
  if (sent.length || force || p.getProperty('GRA_R2_INDEX') !== listed) {
    try { R2_writeIndex_(c, current); p.setProperty('GRA_R2_INDEX', listed); } catch (e) { failed.push('index.json (' + String(e && e.message || e).slice(0, 200) + ')'); }
  }
  if (sent.length) out.push('R2: copied ' + sent.join(', '));
  if (waiting) out.push('R2: ' + waiting + ' half-year(s) not sent yet (time limit): click "move ready half-years now" again');
  if (failed.length) {
    out.push('R2 upload failed: ' + failed.join('; '));
    GRA_mail_(s, 'GR Archive: Cloudflare R2 upload failed',
      '<p>These half-years could not be copied to Cloudflare R2:</p><ul>' + failed.map(function (f) { return '<li>' + GRA_esc_(f) + '</li>'; }).join('') +
      '</ul><p>The Drive archive is fine and nothing was deleted. The next run tries again. ' +
      'Menu: GR PNL Engine &gt; Archive (6 months) &gt; Cloudflare R2: test connection.</p>');
  }
  if (!out.length && force) out.push('R2 already has every archived half-year (' + keys.length + ').');
  return out.join(' | ');
}

/**
 * A half-year goes to R2 (and may leave the engine) once it ended FREEZE_AFTER_DAYS days ago (default 45), so the
 * late corrections of its last month come in first. On 19 Nov 2026: FY25-26 H1, H2 and FY26-27 H1 (ended 30 Sep).
 */
function R2_readyHalf_(periodKey, s) {
  if (!/^FY\d\d-\d\d_H[12]$/.test(String(periodKey))) return false;
  var end = GRA_halfOf_(GRA_labelStart_(periodKey)).end.split('-').map(Number);
  var days = Number((s || {}).FREEZE_AFTER_DAYS);
  if (!(days >= 0)) days = 45;
  var ready = Utilities.formatDate(new Date(end[0], end[1] - 1, end[2] + days), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  return GRA_todayIso_() >= ready;
}

function R2_fileKey_(periodKey) { return R2_PREFIX + 'GR_MASTER_' + periodKey + '.json.gz'; }

/** "FY25-26_H2" -> "2025-10-01" (a date inside that half-year). */
function GRA_labelStart_(key) {
  var m = String(key).match(/^FY(\d\d)-(\d\d)_H([12])$/);
  return m ? '20' + m[1] + (m[3] === '1' ? '-04-01' : '-10-01') : '2000-04-01';
}

/** index.json lists only half-years that are CURRENT in the Drive archive and copied to R2 with the same data. */
function R2_writeIndex_(c, current) {
  var p = PropertiesService.getScriptProperties(), periods = {};
  Object.keys(current).forEach(function (key) {
    var meta = JSON.parse(p.getProperty('GRA_R2_' + key) || 'null'), fp = GRA_storedFp_(key);
    if (meta && fp && meta.hash === fp.hash) periods[key] = meta;
  });
  var body = JSON.stringify({ updatedAt: new Date().toISOString(), periods: periods });
  R2_put_(c, R2_PREFIX + 'index.json', Utilities.newBlob(body, 'application/json'));
}

/* ------------------------------------------------------------------ website first load */

/**
 * For Cache.gs writeMasterSnapshot_: a test "this row is left out of the website's first load", or null.
 * A row is left out only when its month is before (current FY start - DASHBOARD_MONTHS_BEFORE_FY months)
 * AND its half-year is in R2 with the same data the archive verified (hash). Everything else stays in.
 */
function GRA_dashboardDrop_(headers) {
  if (!R2_cfg_()) return null;
  var p = PropertiesService.getScriptProperties(), set = {}, halves = [];
  var s = GRA_settings_(GRA_engineSs_());
  p.getKeys().forEach(function (k) {
    if (k.indexOf('GRA_R2_') !== 0 || k === 'GRA_R2_INDEX') return;
    var key = k.slice(7), meta = JSON.parse(p.getProperty(k) || 'null'), fp = GRA_storedFp_(key);
    if (meta && fp && meta.hash === fp.hash && R2_readyHalf_(key, s)) { set[key] = 1; halves.push(key); }
  });
  if (!halves.length) return null;
  var di = GRA_col_(headers, s.DATE_COLUMN);
  if (di < 0) return null;
  var back = Math.max(0, Number(s.DASHBOARD_MONTHS_BEFORE_FY) || 7);
  var now = new Date(), fy = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
  var from = Utilities.formatDate(new Date(fy, 3 - back, 1), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  var memo = {};
  var fn = function (row) {
    var v = row[di], c = memo[v];
    if (c === undefined) { var iso = GRA_iso_(v); c = memo[v] = !!(iso && iso < from && set[GRA_halfOf_(iso).key]); }
    return c;
  };
  fn.from = from; fn.halves = halves.sort();
  return fn;
}

/* ------------------------------------------------------------------ freeze: old half-years leave the engine */

var FRZ_PROP = 'ENGINE_FROZEN';           // { FY26-27_H1: { start, end, rows, hash, at } }  read by the engine (Main.gs)
var FRZ_BLOCK_PROP = 'ENGINE_FREEZE_BLOCKED';   // old versions only: cleared by the next freeze

function engineFrozen_() {
  try { return JSON.parse(PropertiesService.getScriptProperties().getProperty(FRZ_PROP) || '{}') || {}; } catch (e) { return {}; }
}
function engineSetFrozen_(fz) {
  var p = PropertiesService.getScriptProperties();
  if (Object.keys(fz).length) p.setProperty(FRZ_PROP, JSON.stringify(fz)); else p.deleteProperty(FRZ_PROP);
}
function engineFrozenSig_(fz) { return Object.keys(fz || {}).sort().join(','); }

/** Test for one value of the date column: the frozen half-year it falls in, or ''. Undated rows are never frozen. */
function engineFrozenTest_(fz) {
  var memo = {};
  return function (v) {
    var k = v instanceof Date ? GRA_iso_(v) : String(v == null ? '' : v);
    var hit = memo[k];
    if (hit === undefined) {
      var iso = GRA_iso_(v);
      hit = memo[k] = iso ? (fz[GRA_halfOf_(iso).key] ? GRA_halfOf_(iso).key : '') : '';
    }
    return hit;
  };
}

/** Half-years a source file holds ('' = rows without a date): saved with the file in the engine manifest. */
function engineHalvesOf_(values) {
  var seen = {}, memo = {};
  for (var i = 0; i < values.length; i++) {
    var v = values[i], k = v instanceof Date ? GRA_iso_(v) : String(v == null ? '' : v);
    if (memo[k]) continue;
    memo[k] = 1;
    var iso = GRA_iso_(v);
    seen[iso ? GRA_halfOf_(iso).key : ''] = 1;
  }
  return Object.keys(seen).sort();
}

/** True when every row of the file is in a frozen half-year (the engine does not need to read it). */
function engineFileFrozen_(halves, fz) {
  return !!(halves && halves.length) && halves.every(function (k) { return k && fz[k]; });
}

/** Date column the freeze looks at (the archive's DATE_COLUMN, GR DT). */
function engineFreezeColumn_() {
  try { return GRA_settings_(GRA_engineSs_()).DATE_COLUMN || 'GR DT'; } catch (e) { return 'GR DT'; }
}

/**
 * Called at the end of a clean archive run, after the R2 copy (Archive.gs GRA_run_). Freezes each half-year that:
 * ended FREEZE_AFTER_DAYS days ago, is archived and verified (heal OK, same row count), is in R2 with the same
 * data (hash) and listed in archive/index.json.
 * The engine then rebuilds without those months (in about 1 minute) and checks the row count.
 */
function GRA_freeze_(ss, s, heal) {
  if (String(s.FREEZE_ON || 'NO').toUpperCase() !== 'YES') return '';
  var c = R2_cfg_();
  if (!c) return '';
  var p = PropertiesService.getScriptProperties(), fz = engineFrozen_(), added = [];
  p.deleteProperty(FRZ_BLOCK_PROP);   // old versions kept a block list; a click is the owner's decision
  var listed = String(p.getProperty('GRA_R2_INDEX') || '').split(',');
  (heal.periods || []).forEach(function (x) {
    var key = x.key;
    if (!x.ok || fz[key] || !R2_readyHalf_(key, s) || listed.indexOf(key) < 0) return;
    var fp = GRA_storedFp_(key), meta = JSON.parse(p.getProperty('GRA_R2_' + key) || 'null');
    if (!fp || !meta || meta.hash !== fp.hash || fp.rows !== x.rows) return;
    try { if (!R2_exists_(c, R2_fileKey_(key))) return; } catch (e) { return; }
    var h = GRA_halfOf_(GRA_labelStart_(key));
    fz[key] = { start: h.start, end: h.end, rows: fp.rows, hash: fp.hash, at: new Date().toISOString() };
    added.push(key);
  });
  if (!added.length) return '';
  engineSetFrozen_(fz);
  if (typeof scheduleContinuation_ === 'function') scheduleContinuation_();   // the engine rebuilds without these months
  GRA_mail_(s, 'GR engine: ' + added.join(', ') + ' now read from Cloudflare R2',
    '<p>These half-years are archived, verified and in Cloudflare R2 with the same data:</p><ul>' +
    added.map(function (k) { return '<li>' + GRA_esc_(GRA_labelOf_(k)) + ': ' + GRA_fmt_(fz[k].rows) + ' GRs</li>'; }).join('') +
    '</ul><p>The engine stops reading them (less memory on every refresh). The website loads them from R2 by itself. ' +
    'If a source file later changes rows of these months, it is not applied and you get a mail. To apply it: ' +
    'Archive &gt; Frozen half-years: take one back into the engine, wait for the refresh and the archive run, then ' +
    'Cloudflare R2: move ready half-years now.</p>');
  return 'Frozen (engine stops reading, website reads R2): ' + added.join(', ');
}

/**
 * Engine side (Main.gs), in the run right after a freeze (every file read): each newly frozen half-year must hold
 * exactly the GRs its archive counted (= the R2 copy). One that does not (its data changed after the archive
 * was checked) is taken back into the engine; the others stay frozen. Returns a note or ''.
 */
function engineFreezeCheck_(count, newly, fz) {
  var bad = newly.filter(function (k) { return (count[k] || 0) !== (Number(fz[k] && fz[k].rows) || 0); });
  if (!bad.length) return '';
  var lines = bad.map(function (k) { return k + ': engine ' + (count[k] || 0) + ' GRs, archive / R2 ' + fz[k].rows; });
  bad.forEach(function (k) { delete fz[k]; });
  engineSetFrozen_(fz);
  try {
    GRA_mail_(GRA_settings_(GRA_engineSs_()), 'GR engine: freeze undone for ' + bad.join(', '),
      '<p>The engine data of these half-years is not the same as their archive / R2 copy, so they stay in the engine ' +
      '(nothing is lost, the dashboard is correct):</p><ul>' + lines.map(function (l) { return '<li>' + GRA_esc_(l) + '</li>'; }).join('') +
      '</ul><p>Usually a file of those months changed after the last archive run. Click ' +
      '<b>Cloudflare R2: move ready half-years now</b> again: it first updates the archive, then uploads and freezes.</p>' +
      (Object.keys(fz).length ? '<p>Still frozen: ' + GRA_esc_(Object.keys(fz).sort().join(', ')) + '.</p>' : ''));
  } catch (e) {}
  return 'Freeze check: ' + lines.join('; ') + ' → taken back';
}

/**
 * Nightly archive run (R2_AUTO_MOVE = YES), at the end of a clean run (archive up to date with the engine, nothing
 * to rebuild): copies each ready half-year to R2, then freezes the ones R2 has with the same data. Same steps as
 * the menu "Cloudflare R2: move ready half-years now". Returns { text, more } (more = time ran out, continue later).
 */
function GRA_autoMove_(ss, s, heal, t0) {
  if (String(s.FREEZE_ON || 'NO').toUpperCase() !== 'YES' || !R2_cfg_()) return { text: '', more: false };
  if (Date.now() - t0 > GRA_TIME_BUDGET_MS - 60 * 1000) return { text: 'R2 move: continues in the next step (time limit)', more: true };
  var fz = engineFrozen_(), todo = (heal.periods || []).filter(function (x) { return x.ok && !fz[x.key] && R2_readyHalf_(x.key, s); });
  if (!todo.length) return { text: '', more: false };
  var sync = GRA_r2Sync_(ss, s, t0, false);
  var more = /not sent yet/.test(sync || '');
  var fr = GRA_freeze_(ss, s, heal);
  return { text: [sync, fr].filter(String).join(' | '), more: more };
}

/** Nightly archive run: one mail per half-year that is ready to move to R2 (nothing is uploaded). */
function GRA_freezeRemind_(ss, s, heal) {
  if (String(s.FREEZE_ON || 'NO').toUpperCase() !== 'YES' || !R2_cfg_()) return '';
  var p = PropertiesService.getScriptProperties(), fz = engineFrozen_(), ready = [];
  (heal.periods || []).forEach(function (x) {
    if (!x.ok || fz[x.key] || !R2_readyHalf_(x.key, s)) return;
    var fp = GRA_storedFp_(x.key);
    if (!fp || p.getProperty('GRA_FRZ_REMIND_' + x.key) === fp.hash) return;
    p.setProperty('GRA_FRZ_REMIND_' + x.key, fp.hash);
    ready.push(x.key);
  });
  if (!ready.length) return '';
  GRA_mail_(s, 'GR Archive: ' + ready.join(', ') + ' ready to move to Cloudflare R2',
    '<p>These half-years ended ' + GRA_esc_(s.FREEZE_AFTER_DAYS) + '+ days ago and their archive is verified:</p><ul>' +
    ready.map(function (k) { return '<li>' + GRA_esc_(GRA_labelOf_(k)) + '</li>'; }).join('') + '</ul>' +
    '<p>When you are ready: engine sheet &gt; GR PNL Engine &gt; Archive (6 months) &gt; ' +
    '<b>Cloudflare R2: move ready half-years now</b>. It uploads them, then the engine stops reading them ' +
    '(the website reads them from R2). Nothing happens until you click.</p>');
  return 'Ready for R2 (mail sent, waiting for the menu): ' + ready.join(', ');
}

/** Engine (Main.gs): a new / changed source file has rows of frozen half-years. Not applied; one mail. */
function engineFrozenTouched_(touched) {
  var keys = Object.keys(touched).sort();
  var text = 'Not applied (half-year is frozen in R2): ' + keys.map(function (k) { return k + ' (' + touched[k] + ')'; }).join(', ');
  try {
    GRA_mail_(GRA_settings_(GRA_engineSs_()), 'GR engine: changed file for a frozen half-year (' + keys.join(', ') + ')',
      '<p>These files were added or changed, but they have rows of a half-year that is frozen (kept in Cloudflare R2):</p><ul>' +
      keys.map(function (k) { return '<li>' + GRA_esc_(GRA_labelOf_(k)) + ': ' + GRA_esc_(touched[k]) + '</li>'; }).join('') +
      '</ul><p>Those rows are <b>not</b> applied; the dashboard keeps the R2 data. To apply the change: Archive (6 months) &gt; ' +
      '<b>Frozen half-years: take one back into the engine</b>, wait for the refresh and the archive run (or Run archive now), ' +
      'then <b>Cloudflare R2: move ready half-years now</b>. If the change was not meant for those months, do nothing.</p>');
  } catch (e) {}
  return text;
}

/** Menu: take one frozen half-year back into the engine (to apply a changed file, then move it to R2 again). */
function GRA_unfreezeOne() {
  var ui = SpreadsheetApp.getUi(), fz = engineFrozen_(), keys = Object.keys(fz).sort();
  if (!keys.length) { GRA_dialog_('Frozen half-years', 'Nothing is frozen.', ''); return; }
  var r = ui.prompt('Take one half-year back into the engine', 'Frozen now: ' + keys.join(', ') +
    '\n\nType the one to take back (for example ' + keys[keys.length - 1] + ').', ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  var key = String(r.getResponseText() || '').trim().toUpperCase();
  if (!fz[key]) { GRA_dialog_('Frozen half-years', key + ' is not frozen. Frozen: ' + keys.join(', '), ''); return; }
  delete fz[key];
  engineSetFrozen_(fz);
  scheduleContinuation_();
  GRA_dialog_('Frozen half-years', key + ' comes back into the engine in about 1 minute (with any changed files). ' +
    'After the archive run (nightly, or Run archive now), use "Cloudflare R2: move ready half-years now" to send it to R2 again.', '');
}

/** Menu: what is frozen, and a way to take everything back into the engine. */
function GRA_freezeStatus() {
  var fz = engineFrozen_(), keys = Object.keys(fz).sort();
  var t = keys.length ? keys.map(function (k) { return GRA_labelOf_(k) + ': ' + GRA_fmt_(fz[k].rows) + ' GRs, frozen ' + String(fz[k].at).slice(0, 10); }).join('\n')
                      : 'Nothing is frozen. The engine reads every month.';
  GRA_dialog_('Frozen half-years (read from Cloudflare R2)', t, '');
}
function GRA_unfreezeAll() {
  var ui = SpreadsheetApp.getUi();
  if (ui.alert('Take every frozen half-year back into the engine?', 'The next refresh reads them again (more memory). ' +
      'They are frozen again only when you use "Cloudflare R2: move ready half-years now".', ui.ButtonSet.OK_CANCEL) !== ui.Button.OK) return;
  engineSetFrozen_({});
  scheduleContinuation_();
  GRA_dialog_('Frozen half-years', 'Done. The engine takes them back in about 1 minute.', '');
}

/* ------------------------------------------------------------------ S3 API (Signature V4) */

function R2_missing_() {
  var p = PropertiesService.getScriptProperties();
  return R2_PROPS.filter(function (n) { return !p.getProperty(n); });
}

function R2_cfg_() {
  var p = PropertiesService.getScriptProperties();
  if (R2_missing_().length) return null;
  return { account: p.getProperty('R2_ACCOUNT_ID'), bucket: p.getProperty('R2_BUCKET'),
           id: p.getProperty('R2_ACCESS_KEY_ID'), secret: p.getProperty('R2_SECRET_ACCESS_KEY') };
}

function R2_put_(c, key, blob) {
  var r = R2_req_(c, 'PUT', key, blob);
  if (r.getResponseCode() !== 200) throw new Error('PUT ' + key + ': HTTP ' + r.getResponseCode() + ' ' + r.getContentText().slice(0, 300));
}

/* UrlFetchApp has no HEAD method ("Attribute provided with invalid value: method"): read only the first byte instead. */
function R2_exists_(c, key) { var code = R2_req_(c, 'GET', key, null, { Range: 'bytes=0-0' }).getResponseCode(); return code === 200 || code === 206; }

function R2_req_(c, method, key, blob, extra) {
  var host = c.account + '.r2.cloudflarestorage.com';
  var path = '/' + encodeURIComponent(c.bucket) + '/' + String(key).split('/').map(R2_enc_).join('/');
  var now = new Date();
  var amzDate = Utilities.formatDate(now, 'UTC', "yyyyMMdd'T'HHmmss'Z'"), day = amzDate.slice(0, 8);
  var payloadHash = 'UNSIGNED-PAYLOAD';
  var canonHeaders = 'host:' + host + '\nx-amz-content-sha256:' + payloadHash + '\nx-amz-date:' + amzDate + '\n';
  var signed = 'host;x-amz-content-sha256;x-amz-date';
  var canon = [method, path, '', canonHeaders, signed, payloadHash].join('\n');
  var scope = day + '/auto/s3/aws4_request';
  var toSign = ['AWS4-HMAC-SHA256', amzDate, scope, R2_hex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, canon, Utilities.Charset.UTF_8))].join('\n');
  var k = R2_hmac_(R2_bytes_('AWS4' + c.secret), day);
  k = R2_hmac_(k, 'auto'); k = R2_hmac_(k, 's3'); k = R2_hmac_(k, 'aws4_request');
  var sig = R2_hex_(R2_hmac_(k, toSign));
  var opt = {
    method: method.toLowerCase(), muteHttpExceptions: true, followRedirects: false,
    headers: { 'x-amz-date': amzDate, 'x-amz-content-sha256': payloadHash,
               Authorization: 'AWS4-HMAC-SHA256 Credential=' + c.id + '/' + scope + ', SignedHeaders=' + signed + ', Signature=' + sig }
  };
  if (extra) Object.keys(extra).forEach(function (h) { opt.headers[h] = extra[h]; });   // not signed (allowed by SigV4)
  if (blob) { opt.payload = blob; opt.contentType = blob.getContentType() || 'application/octet-stream'; }
  return UrlFetchApp.fetch('https://' + host + path, opt);
}

function R2_enc_(s) { return encodeURIComponent(s).replace(/[!'()*]/g, function (ch) { return '%' + ch.charCodeAt(0).toString(16).toUpperCase(); }); }
function R2_bytes_(s) { return Utilities.newBlob(String(s)).getBytes(); }
function R2_hmac_(keyBytes, text) { return Utilities.computeHmacSignature(Utilities.MacAlgorithm.HMAC_SHA_256, R2_bytes_(text), keyBytes); }
function R2_hex_(bytes) { return bytes.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join(''); }
