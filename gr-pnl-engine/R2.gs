/**
 * Cloudflare R2: a copy of every verified half-year archive, for the dashboard website.
 *
 * Archive.gs builds each finished half-year (Drive sheet + gzip JSON, verified). At the end of every
 * archive run, GRA_r2Sync_ sends each CURRENT gzip JSON of an ended financial year that R2 does not have yet (or has an older
 * version of) to the R2 bucket, plus a small index:
 *     archive/GR_MASTER_FY25-26_H1.json.gz
 *     archive/index.json      { updatedAt, periods: { FY25-26_H1: { label, start, end, rows, hash, bytes, at } } }
 * The website (Cloudflare Pages, function /archive/...) reads them from the same bucket when someone
 * clicks "+ Load last year". The bucket is never public: the website checks the sign-in first.
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

/** Menu: sends every archived half-year that R2 does not have yet. Long lists continue by themselves. */
function R2_uploadNow() {
  var ss = GRA_engineSs_(), s = GRA_settings_(ss), t0 = Date.now(), text;
  var lock = LockService.getDocumentLock() || LockService.getScriptLock();
  if (!lock.tryLock(30000)) { GRA_dialog_('Cloudflare R2', 'An archive run is going. It copies to R2 by itself at its end.', ''); return; }
  try { text = GRA_r2Sync_(ss, s, t0, true) || 'R2 keys are not saved yet.'; }
  finally { lock.releaseLock(); }
  GRA_dialog_('Cloudflare R2', text, '');
}

/* ------------------------------------------------------------------ archive hook */

/**
 * Called at the end of every finished archive run (Archive.gs GRA_run_). Uploads each CURRENT half-year
 * JSON of an ended financial year (R2_closedFy_) whose R2 copy is missing or older, then rewrites archive/index.json. Returns a line for the log.
 * Never throws: a failed upload is logged and mailed, the Drive archive is not touched.
 */
function GRA_r2Sync_(ss, s, t0, force) {
  var c = R2_cfg_();
  if (!c) return '';
  var p = PropertiesService.getScriptProperties(), sent = [], failed = [], waiting = 0, current = {};
  GRA_registry_(ss).forEach(function (x) { if (x.status === 'CURRENT' && x.part === 'JSON' && R2_closedFy_(x.key)) current[x.key] = x; });
  var keys = Object.keys(current).sort();   // oldest first (FY25-26 H1, H2, ...); the running FY is not sent
  for (var i = 0; i < keys.length; i++) {
    var key = keys[i], fp = GRA_storedFp_(key);
    if (!fp) continue;
    var meta = JSON.parse(p.getProperty('GRA_R2_' + key) || 'null');
    if (meta && meta.hash === fp.hash && !force) continue;
    if (meta && meta.hash === fp.hash && force && R2_exists_(c, R2_fileKey_(key))) continue;
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
  if (waiting) { out.push('R2: ' + waiting + ' half-year(s) left, continues in 1 min'); GRA_scheduleContinue_(1); }
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
 * Only half-years of a financial year that has ended go to R2 (FY25-26 and older today). The running FY
 * still changes and the dashboard gets it from the engine; its half-years go to R2 after 31 March.
 */
function R2_closedFy_(periodKey) {
  var m = String(periodKey).match(/^FY(\d\d)-/);
  if (!m) return false;
  var now = new Date(), fy = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
  return 2000 + Number(m[1]) < fy;
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
  p.getKeys().forEach(function (k) {
    if (k.indexOf('GRA_R2_') !== 0 || k === 'GRA_R2_INDEX') return;
    var key = k.slice(7), meta = JSON.parse(p.getProperty(k) || 'null'), fp = GRA_storedFp_(key);
    if (meta && fp && meta.hash === fp.hash && R2_closedFy_(key)) { set[key] = 1; halves.push(key); }
  });
  if (!halves.length) return null;
  var s = GRA_settings_(GRA_engineSs_()), di = GRA_col_(headers, s.DATE_COLUMN);
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

function R2_exists_(c, key) { return R2_req_(c, 'HEAD', key, null).getResponseCode() === 200; }

function R2_req_(c, method, key, blob) {
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
  if (blob) { opt.payload = blob; opt.contentType = blob.getContentType() || 'application/octet-stream'; }
  return UrlFetchApp.fetch('https://' + host + path, opt);
}

function R2_enc_(s) { return encodeURIComponent(s).replace(/[!'()*]/g, function (ch) { return '%' + ch.charCodeAt(0).toString(16).toUpperCase(); }); }
function R2_bytes_(s) { return Utilities.newBlob(String(s)).getBytes(); }
function R2_hmac_(keyBytes, text) { return Utilities.computeHmacSignature(Utilities.MacAlgorithm.HMAC_SHA_256, R2_bytes_(text), keyBytes); }
function R2_hex_(bytes) { return bytes.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join(''); }
