/**
 * SCOT > Cross Sell FMS sync (bound to the SCOT MeCA Google Sheet).
 *
 * When an SC fills "Visit Align to FS (name)" on any SCOT tab, that client row is appended to the
 * "field team & SC FMS for cross sell" tab (only the mapped columns) and a mail goes to the FS.
 * Everything is set from FMS_Settings and FMS_Column_Map in a separate admin-only spreadsheet
 * ("Cross Sell FMS - Admin"), so people using the SCOT sheet never see them.
 * Menu: Cross Sell FMS > Setup (run once), Sync now, Open admin settings, Give admin access.
 * No menu? Open Extensions > Apps Script, pick `setup` in the function list and press Run.
 */

// The SCOT MeCA sheet. Used when the script is not opened from the sheet itself (run from the editor).
var SHEET_ID = '1kY8FIMft0TzA50v1B25arZzLTIs9_fGOn2WhXIg0BCo';
var SETTINGS_TAB = 'FMS_Settings';
var MAP_TAB = 'FMS_Column_Map';
var LOG_TAB = 'FMS_Log';
var HELD = 'held (mail off)';

// key, default value, help text. New keys are added to FMS_Settings by Setup; existing values are kept.
var DEFAULT_SETTINGS = [
  ['SOURCE_TABS', 'SCOT - *', 'Tabs to read, comma separated. * = any text (SCOT - * picks every SC tab, new ones too)'],
  ['TARGET_TAB', 'field team & SC FMS for cross s*', 'Tab the rows are appended to (* allowed)'],
  ['TRIGGER_COLUMN', 'Visit Align to FS', 'Source column (header text) that starts the move when it gets a name'],
  ['IGNORE_VALUES', 'No, NA, N/A, -, 0, Nil', 'Values in the trigger column that do NOT count as a name'],
  ['REQUIRE_COLUMNS', '', 'Optional: more source columns that must be filled before the move (e.g. FS Email ID)'],
  ['MATCH_COLUMNS', 'SC NAME, Client Name (CNGR), Origin Branch, Destination', 'Target columns that identify the same client row (no duplicates; later changes update that row)'],
  ['UPDATE_EXISTING', 'Yes', 'Yes = when the SCOT row changes later, refresh the mapped cells in the FMS row'],
  ['SEND_MAIL', 'No', 'Yes = mail the FS when a row moves to the FMS. No = hold (rows still move; menu "Send held mails" sends them later)'],
  ['MAIL_TO_COLUMN', 'FS Email ID', 'Source column with the FS mail ID (mail goes here)'],
  ['MAIL_CC', '', 'Always CC these mail IDs (comma separated)'],
  ['SC_EMAILS', '', 'Optional SC mail IDs to CC per SC: UNNATI=a@x.com, SONAL=b@x.com'],
  ['MAIL_SUBJECT', 'Cross sell visit aligned: {Client Name (CNGR)} ({SC NAME})', 'Subject. {Column header} is replaced with the value'],
  ['MAIL_INTRO', 'Hi {FSR Name}, a customer visit has been aligned to you for cross sell. Details below.', 'First line of the mail'],
  ['SYNC_EVERY_MINUTES', '15', 'Background sync for pasted or formula values: 1, 5, 10, 15 or 30. 0 = off'],
  ['ADMIN_EMAILS', '', 'Only these people can edit the FMS_ tabs after "Lock settings to admins"'],
];

// Target header <- source header. Admin edits FMS_Column_Map to add, drop or change columns.
var DEFAULT_MAP = [
  ['SC NAME', 'SC NAME'],
  ['Client Name (CNGR)', 'Client Name (CNGR)'],
  ['Contact Person', 'Contact Person'],
  ['Mob', 'Mob'],
  ['product (FTL/LTL)', 'product (FTL/LTL)'],
  ['Origin Branch', 'Origin Branch'],
  ['Destination', 'Destination'],
  ['Email', 'Email'],
  ['Avg. BIZ (april-AUG)', 'Monthly Avg orders pm in lacs (april-AUG)'],
  ['FSR Name', 'Visit Align to FS'],
  ['FSR (email)', 'FS Email ID'],
];

/* ---------- menu and triggers ---------- */

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Cross Sell FMS')
    .addItem('Sync now', 'syncNow')
    .addItem('Setup (run once / after settings change)', 'setup')
    .addSeparator()
    .addItem('Open admin settings', 'openAdmin')
    .addItem('Give admin access to ADMIN_EMAILS', 'lockSettings')
    .addItem('Mail ON / OFF', 'toggleMail')
    .addItem('Send held mails', 'sendHeldMails')
    .addToUi();
}

function setup() {
  var adm = admin_(true);
  ensureSettingsTab_(adm);
  ensureMapTab_(adm);
  ensureLogTab_(adm);
  moveOldAdminTabs_(adm);

  var me = Session.getEffectiveUser().getEmail();
  var admins = getSettings_().ADMIN_EMAILS;
  if (!admins && me) setSetting_('ADMIN_EMAILS', me);

  // Rows already aligned before Setup are moved without mail; only new ones send mail.
  var firstRun = !PropertiesService.getDocumentProperties().getProperty('SETUP_DONE');
  installTriggers_();
  var res = sync_({ mail: !firstRun });
  PropertiesService.getDocumentProperties().setProperty('SETUP_DONE', new Date().toISOString());

  notify_('Cross Sell FMS is ready.\n\n' + summary_(res) +
    (firstRun ? '\n\nFirst run: rows already aligned were moved without mail.' : '') +
    '\nMail is ' + (/^y/i.test(getSettings_().SEND_MAIL) ? 'ON.' : 'OFF (on hold). Turn it on from the menu: Mail ON / OFF.') +
    '\n\nAdmin settings (only admins can open): ' + adm.getUrl());
}

function syncNow() {
  var res = sync_({ mail: true });
  try { ss_().toast(summary_(res), 'Cross Sell FMS', 8); } catch (e) { console.log(summary_(res)); }
}

function openAdmin() {
  var url = admin_().getUrl();
  var html = HtmlService.createHtmlOutput('<p style="font-family:Arial">Admin settings (only admins can open it):</p>' +
    '<p><a href="' + url + '" target="_blank" style="font-family:Arial">Open Cross Sell FMS - Admin</a></p>').setWidth(360).setHeight(120);
  try { SpreadsheetApp.getUi().showModalDialog(html, 'Cross Sell FMS'); } catch (e) { console.log(url); }
}

// The settings live in a separate spreadsheet, so people using the SCOT sheet never see them.
// Only ADMIN_EMAILS are editors of it; everyone else is removed.
function lockSettings() {
  var adm = admin_();
  var admins = splitList_(getSettings_().ADMIN_EMAILS).filter(isEmail_).map(function (m) { return m.toLowerCase(); });
  var me = Session.getEffectiveUser().getEmail();
  if (me && admins.indexOf(me.toLowerCase()) < 0) admins.push(me.toLowerCase());
  var owner = adm.getOwner() ? adm.getOwner().getEmail().toLowerCase() : '';
  adm.getEditors().concat(adm.getViewers()).forEach(function (u) {
    var m = u.getEmail().toLowerCase();
    if (m && m !== owner && admins.indexOf(m) < 0) { adm.removeEditor(m); try { adm.removeViewer(m); } catch (e) {} }
  });
  admins.forEach(function (m) { if (m !== owner) adm.addEditor(m); });
  notify_('Admin settings can be opened only by:\n' + admins.join('\n') +
    '\n\nTo add or remove an admin: change ADMIN_EMAILS in FMS_Settings, then run this again.');
}

// Admin only (others cannot open the admin spreadsheet, so this fails for them).
function toggleMail() {
  var on = !/^y/i.test(getSettings_().SEND_MAIL);
  setSetting_('SEND_MAIL', on ? 'Yes' : 'No');
  notify_('Mail is now ' + (on ? 'ON: new rows mail the FS.' : 'OFF (on hold): rows still move, no mail.') +
    '\nRows held while mail was off are sent only with "Send held mails".');
}

// Sends the mails held while SEND_MAIL was No (and still not sent), whatever SEND_MAIL is now.
function sendHeldMails() {
  var adm = admin_();
  var sh = adm.getSheetByName(LOG_TAB);
  var n = 0;
  if (sh.getLastRow() > 1) {
    var col = sh.getRange(2, 6, sh.getLastRow() - 1, 1).getValues().map(function (r) {
      if (r[0] === HELD) { n++; return ['']; }
      return r;
    });
    sh.getRange(2, 6, col.length, 1).setValues(col);
  }
  if (!n) { notify_('No held mails.'); return; }
  var res = sync_({ mail: true, forceMail: true });
  notify_('Held rows: ' + n + '\n' + summary_(res));
}

// Installable trigger (runs as the person who ran Setup, so it can send mail).
function onEditSync(e) {
  if (!e || !e.range) return;
  var sh = e.range.getSheet();
  if (!matchesAny_(sh.getName(), splitList_(getSettings_().SOURCE_TABS))) return;
  sync_({ mail: true, sheet: sh, fromRow: e.range.getRow(), toRow: e.range.getLastRow() });
}

function timedSync() {
  sync_({ mail: true });
}

function installTriggers_() {
  var ss = ss_();
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (['onEditSync', 'timedSync'].indexOf(t.getHandlerFunction()) >= 0) ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('onEditSync').forSpreadsheet(ss).onEdit().create();
  var mins = parseInt(getSettings_().SYNC_EVERY_MINUTES, 10);
  if ([1, 5, 10, 15, 30].indexOf(mins) >= 0) ScriptApp.newTrigger('timedSync').timeBased().everyMinutes(mins).create();
}

/* ---------- sync ---------- */

function sync_(opt) {
  var lock = LockService.getDocumentLock();
  if (!lock.tryLock(30000)) return { added: 0, updated: 0, mailed: 0, errors: ['Busy, try again'] };
  try {
    return doSync_(opt || {});
  } finally {
    lock.releaseLock();
  }
}

function doSync_(opt) {
  var ss = ss_();
  var cfg = getSettings_();
  var map = getMap_();
  var res = { added: 0, updated: 0, mailed: 0, errors: [] };

  var target = findSheet_(ss, cfg.TARGET_TAB);
  if (!target) { res.errors.push('Target tab not found: ' + cfg.TARGET_TAB); return res; }
  var tgt = readTarget_(target, map);

  var matchCols = splitList_(cfg.MATCH_COLUMNS).map(norm_).filter(function (h) { return tgt.col[h] != null; });
  var ignore = splitList_(cfg.IGNORE_VALUES).map(norm_);
  var required = [cfg.TRIGGER_COLUMN].concat(splitList_(cfg.REQUIRE_COLUMNS));
  var log = readLog_(admin_());

  var sources = opt.sheet ? [opt.sheet] : ss.getSheets().filter(function (s) {
    return matchesAny_(s.getName(), splitList_(cfg.SOURCE_TABS));
  });

  sources.forEach(function (src) {
    var head = findHeader_(src, cfg.TRIGGER_COLUMN);
    if (!head) { res.errors.push(src.getName() + ': column "' + cfg.TRIGGER_COLUMN + '" not found'); return; }
    var first = Math.max(head.row + 1, opt.fromRow || 0);
    var last = Math.min(src.getLastRow(), opt.toRow || src.getLastRow());
    if (last < first) return;
    var width = src.getLastColumn();
    var rows = src.getRange(first, 1, last - first + 1, width).getDisplayValues();

    rows.forEach(function (row, i) {
      var get = function (h) { var k = findKey_(head.col, h); return k == null ? '' : String(row[head.col[k]]).trim(); };
      var ok = required.every(function (h) { var v = get(h); return v && ignore.indexOf(norm_(v)) < 0; });
      if (!ok) return;

      // Target values for this row, by target header.
      var vals = {};
      map.forEach(function (m) { vals[norm_(m.target)] = get(m.source); });
      if (tgt.col[norm_('SC NAME')] != null && !vals[norm_('SC NAME')]) vals[norm_('SC NAME')] = scFromTab_(src.getName());

      var key = matchCols.map(function (h) { return norm_(vals[h] || ''); }).join('|');
      if (!key.replace(/\|/g, '')) return;

      var at = tgt.index[key];
      if (at == null) {
        at = tgt.nextRow++;
        writeRow_(target, tgt, at, vals);
        tgt.index[key] = at;
        res.added++;
      } else if (/^y/i.test(cfg.UPDATE_EXISTING)) {
        if (writeRow_(target, tgt, at, vals, tgt.rows[at])) res.updated++;
      }
      tgt.rows[at] = vals;

      var entry = log[key];
      var mailTo = get(cfg.MAIL_TO_COLUMN);
      if (!entry) {
        entry = log[key] = { key: key, tab: src.getName(), row: first + i, fs: get(cfg.TRIGGER_COLUMN), added: new Date(), mailed: '', isNew: true };
      }
      entry.dirty = true;
      entry.row = first + i;
      entry.fs = get(cfg.TRIGGER_COLUMN);
      var mailOn = opt.forceMail || /^y/i.test(cfg.SEND_MAIL);
      if (opt.mail && mailOn && !entry.mailed) {
        try {
          if (sendMail_(cfg, map, vals, mailTo, get('SC NAME') || scFromTab_(src.getName()))) {
            entry.mailed = new Date();
            res.mailed++;
          }
        } catch (err) {
          res.errors.push('Mail failed for ' + (vals[norm_('Client Name (CNGR)')] || key) + ': ' + err.message);
        }
      } else if (!opt.mail && !entry.mailed && entry.isNew) {
        entry.mailed = 'skipped (before setup)';
      } else if (opt.mail && !mailOn && !entry.mailed) {
        entry.mailed = HELD;
      }
    });
  });

  writeLog_(admin_(), log);
  return res;
}

/* ---------- target tab ---------- */

// Header row = the row (in the first 15) holding the most mapped target headers. Merged
// two-row headers (e.g. SC NAME on the row above) are read from the row above when blank.
function readTarget_(sh, map) {
  var top = sh.getRange(1, 1, Math.min(15, Math.max(sh.getLastRow(), 1)), Math.max(sh.getLastColumn(), 1)).getDisplayValues();
  var wanted = map.map(function (m) { return norm_(m.target); });
  var best = 0, bestHits = -1;
  top.forEach(function (r, i) {
    var hits = r.filter(function (v) { return wanted.indexOf(norm_(v)) >= 0; }).length;
    if (hits > bestHits) { best = i; bestHits = hits; }
  });
  var headerRow = best + 1;
  var col = {};
  top[best].forEach(function (v, c) {
    var h = norm_(v) || (best > 0 ? norm_(top[best - 1][c]) : '');
    if (h && col[h] == null) col[h] = c;
  });

  // A mapped target column missing from the tab is added at the end of the header row.
  wanted.forEach(function (h, i) {
    if (col[h] != null) return;
    var c = sh.getLastColumn();
    sh.getRange(headerRow, c + 1).setValue(map[i].target).setFontWeight('bold');
    col[h] = c;
  });

  var t = { headerRow: headerRow, col: col, index: {}, rows: {}, nextRow: headerRow + 1 };
  var last = sh.getLastRow();
  if (last > headerRow) {
    var data = sh.getRange(headerRow + 1, 1, last - headerRow, sh.getLastColumn()).getDisplayValues();
    var cfg = getSettings_();
    var matchCols = splitList_(cfg.MATCH_COLUMNS).map(norm_).filter(function (h) { return col[h] != null; });
    data.forEach(function (r, i) {
      var rowNo = headerRow + 1 + i;
      var filled = wanted.some(function (h) { return String(r[col[h]]).trim(); });
      if (!filled) return;
      t.nextRow = rowNo + 1;
      var vals = {};
      wanted.forEach(function (h) { vals[h] = String(r[col[h]]).trim(); });
      var key = matchCols.map(function (h) { return norm_(vals[h] || ''); }).join('|');
      if (key.replace(/\|/g, '') && t.index[key] == null) { t.index[key] = rowNo; t.rows[rowNo] = vals; }
    });
  }
  return t;
}

// Writes only the mapped cells, so the SC's own Pln / Act columns are never touched.
// With `old`, writes only cells that changed and returns whether anything did.
function writeRow_(sh, t, rowNo, vals, old) {
  var changed = false;
  Object.keys(vals).forEach(function (h) {
    if (t.col[h] == null) return;
    var v = vals[h];
    if (old && String(old[h] || '') === String(v)) return;
    if (old && !v) return;   // never blank out a cell the SCOT row no longer has
    sh.getRange(rowNo, t.col[h] + 1).setValue(v);
    changed = true;
  });
  return changed;
}

/* ---------- mail ---------- */

function sendMail_(cfg, map, vals, mailTo, sc) {
  var to = splitList_(mailTo).filter(isEmail_);
  var cc = splitList_(cfg.MAIL_CC).filter(isEmail_);
  var scMail = scEmail_(cfg.SC_EMAILS, sc);
  if (scMail) cc.push(scMail);
  if (!to.length && !cc.length) return false;   // nobody to tell yet; retried when a mail ID is added
  if (!to.length) { to = cc; cc = []; }

  var fill = function (s) {
    return String(s || '').replace(/\{([^}]+)\}/g, function (_, h) { return vals[norm_(h)] || ''; });
  };
  var rows = map.map(function (m) {
    return '<tr><td style="padding:4px 10px;border:1px solid #ddd;background:#f6f6f6"><b>' + esc_(m.target) +
      '</b></td><td style="padding:4px 10px;border:1px solid #ddd">' + esc_(vals[norm_(m.target)] || '') + '</td></tr>';
  }).join('');
  var link = ss_().getUrl();
  var html = '<p>' + esc_(fill(cfg.MAIL_INTRO)) + '</p>' +
    '<table style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:13px">' + rows + '</table>' +
    '<p><a href="' + link + '">Open the Cross Sell FMS sheet</a></p>';

  MailApp.sendEmail({
    to: to.join(','),
    cc: cc.join(','),
    subject: fill(cfg.MAIL_SUBJECT),
    htmlBody: html,
    name: 'Sugam Cross Sell FMS',
  });
  return true;
}

function scEmail_(list, sc) {
  var found = '';
  splitList_(list).forEach(function (pair) {
    var p = pair.split('=');
    if (p.length === 2 && norm_(p[0]) === norm_(sc)) found = p[1].trim();
  });
  return isEmail_(found) ? found : '';
}

/* ---------- settings, map and log tabs ---------- */

function ensureSettingsTab_(ss) {
  var sh = ss.getSheetByName(SETTINGS_TAB) || ss.insertSheet(SETTINGS_TAB);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, 3).setValues([['Setting', 'Value', 'What it does']]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  var have = sh.getLastRow() > 1 ? sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues().map(function (r) { return r[0]; }) : [];
  var add = DEFAULT_SETTINGS.filter(function (d) { return have.indexOf(d[0]) < 0; });
  if (add.length) sh.getRange(sh.getLastRow() + 1, 1, add.length, 3).setValues(add);
  sh.setColumnWidth(1, 190).setColumnWidth(2, 380).setColumnWidth(3, 520);
}

function ensureMapTab_(ss) {
  var sh = ss.getSheetByName(MAP_TAB);
  if (sh) return;
  sh = ss.insertSheet(MAP_TAB);
  sh.getRange(1, 1, 1, 3).setValues([['FMS column (target header)', 'SCOT column (source header)', 'Note']]).setFontWeight('bold');
  sh.getRange(2, 1, DEFAULT_MAP.length, 2).setValues(DEFAULT_MAP);
  sh.getRange(2, 3).setValue('Add a row to copy one more column. Header text is matched ignoring case, spaces and line breaks.');
  sh.setFrozenRows(1);
  sh.setColumnWidth(1, 260).setColumnWidth(2, 320).setColumnWidth(3, 520);
}

function ensureLogTab_(ss) {
  var sh = ss.getSheetByName(LOG_TAB);
  if (sh) return;
  sh = ss.insertSheet(LOG_TAB);
  sh.getRange(1, 1, 1, 6).setValues([['Key', 'SCOT tab', 'SCOT row', 'FS name', 'Moved at', 'Mailed at']]).setFontWeight('bold');
  sh.setFrozenRows(1);
}

function getSettings_() {
  var cfg = {};
  DEFAULT_SETTINGS.forEach(function (d) { cfg[d[0]] = d[1]; });
  var adm = admin_();
  var sh = adm && adm.getSheetByName(SETTINGS_TAB);
  if (sh && sh.getLastRow() > 1) {
    sh.getRange(2, 1, sh.getLastRow() - 1, 2).getDisplayValues().forEach(function (r) {
      if (r[0]) cfg[String(r[0]).trim()] = String(r[1]).trim();
    });
  }
  return cfg;
}

function setSetting_(key, value) {
  var sh = admin_().getSheetByName(SETTINGS_TAB);
  var keys = sh.getRange(2, 1, Math.max(sh.getLastRow() - 1, 1), 1).getValues();
  for (var i = 0; i < keys.length; i++) {
    if (keys[i][0] === key) { sh.getRange(i + 2, 2).setValue(value); return; }
  }
}

function getMap_() {
  var adm = admin_();
  var sh = adm && adm.getSheetByName(MAP_TAB);
  var rows = sh && sh.getLastRow() > 1 ? sh.getRange(2, 1, sh.getLastRow() - 1, 2).getDisplayValues() : DEFAULT_MAP;
  return rows.filter(function (r) { return String(r[0]).trim() && String(r[1]).trim(); })
    .map(function (r) { return { target: String(r[0]).trim(), source: String(r[1]).trim() }; });
}

function readLog_(ss) {
  var sh = ss.getSheetByName(LOG_TAB) || (ensureLogTab_(ss), ss.getSheetByName(LOG_TAB));
  var log = {};
  if (sh.getLastRow() > 1) {
    sh.getRange(2, 1, sh.getLastRow() - 1, 6).getValues().forEach(function (r, i) {
      if (r[0]) log[r[0]] = { key: r[0], tab: r[1], row: r[2], fs: r[3], added: r[4], mailed: r[5], at: i + 2 };
    });
  }
  return log;
}

function writeLog_(ss, log) {
  var sh = ss.getSheetByName(LOG_TAB);
  var append = [];
  Object.keys(log).forEach(function (k) {
    var e = log[k];
    if (!e.dirty) return;
    var row = [e.key, e.tab, e.row, e.fs, e.added, e.mailed];
    if (e.at) sh.getRange(e.at, 1, 1, 6).setValues([row]);
    else append.push(row);
  });
  if (append.length) sh.getRange(sh.getLastRow() + 1, 1, append.length, 6).setValues(append);
}

/* ---------- helpers ---------- */

// Admin spreadsheet (settings, column map, log). Created by Setup in the Drive of the person who runs it.
var adminCache_ = null;
function admin_(create) {
  if (adminCache_) return adminCache_;
  var props = PropertiesService.getDocumentProperties();
  var id = props.getProperty('ADMIN_SHEET_ID');
  if (id) {
    try { return (adminCache_ = SpreadsheetApp.openById(id)); } catch (e) { if (!create) throw e; }
  }
  if (!create) return null;
  adminCache_ = SpreadsheetApp.create('Cross Sell FMS - Admin (' + ss_().getName() + ')');
  props.setProperty('ADMIN_SHEET_ID', adminCache_.getId());
  return adminCache_;
}

// Earlier versions kept the FMS_ tabs inside the SCOT sheet: copy them over once and delete them there.
function moveOldAdminTabs_(adm) {
  var ss = ss_();
  [SETTINGS_TAB, MAP_TAB, LOG_TAB].forEach(function (name) {
    var old = ss.getSheetByName(name);
    if (!old) return;
    var to = adm.getSheetByName(name);
    if (old.getLastRow() > 0) {
      var v = old.getRange(1, 1, old.getLastRow(), old.getLastColumn()).getValues();
      to.clear();
      to.getRange(1, 1, v.length, v[0].length).setValues(v);
    }
    ss.deleteSheet(old);
  });
  var blank = adm.getSheetByName('Sheet1');
  if (blank && adm.getSheets().length > 1) adm.deleteSheet(blank);
}

function ss_() {
  return SpreadsheetApp.getActive() || SpreadsheetApp.openById(SHEET_ID);
}

// Popup when run from the sheet menu; the execution log when run from the editor.
function notify_(msg) {
  try { SpreadsheetApp.getUi().alert(msg); } catch (e) { console.log(msg); }
}

// Source header row = first row (in the first 15) that has the trigger column.
function findHeader_(sh, triggerHeader) {
  var n = Math.min(15, sh.getLastRow());
  if (n < 1) return null;
  var top = sh.getRange(1, 1, n, sh.getLastColumn()).getDisplayValues();
  for (var i = 0; i < top.length; i++) {
    var col = {};
    top[i].forEach(function (v, c) { var h = norm_(v); if (h && col[h] == null) col[h] = c; });
    if (findKey_(col, triggerHeader)) return { row: i + 1, col: col };
  }
  return null;
}

// Header lookup: exact match first, otherwise the header that starts with the given text,
// so a short name in the settings ("Visit Align to FS") finds "Visit Align to FS if Yes pls metion name".
function findKey_(col, header) {
  var h = norm_(header);
  if (!h) return null;
  if (col[h] != null) return h;
  var keys = Object.keys(col);
  for (var i = 0; i < keys.length; i++) if (keys[i].indexOf(h) === 0) return keys[i];
  return null;
}

function findSheet_(ss, pattern) {
  var sheets = ss.getSheets();
  for (var i = 0; i < sheets.length; i++) if (matchesAny_(sheets[i].getName(), [pattern])) return sheets[i];
  return null;
}

function matchesAny_(name, patterns) {
  return patterns.some(function (p) {
    var re = new RegExp('^' + p.trim().replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$', 'i');
    return re.test(name.trim());
  });
}

function scFromTab_(name) {
  return name.replace(/^.*-\s*/, '').trim();
}

function norm_(s) {
  return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function splitList_(s) {
  return String(s || '').split(/[,;\n]/).map(function (x) { return x.trim(); }).filter(String);
}

function isEmail_(s) {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(s || '').trim());
}

function esc_(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function summary_(res) {
  return 'Moved: ' + res.added + '   Updated: ' + res.updated + '   Mails sent: ' + res.mailed +
    (res.errors.length ? '\n\nProblems:\n' + res.errors.join('\n') : '');
}
