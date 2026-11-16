/**
 * AUTH.GS
 * -------
 * Email + password sign-in for the shared dashboard link.
 *
 *  - Users live in the USERS sheet of this spreadsheet:
 *      Email | Name | Active | Password_Hash | Salt | Last_Login | Created_On
 *    Passwords are never stored, only a salted SHA-256 hash.
 *  - Sheet menu  GR PNL Engine → Users → Add / reset user  creates a password and
 *    emails it to the person with the dashboard link.
 *  - Signing in returns a session token (kept in the browser). Every data call
 *    (liveApi) must carry a valid token, otherwise it gets LOGIN_REQUIRED.
 *  - Sessions last SETTINGS.SESSION_HOURS (max 6, CacheService limit) and are
 *    extended on every data call. 5 wrong passwords lock that email for 15 minutes.
 */

var USERS_HEADERS_ = ['Email', 'Name', 'Active', 'Password_Hash', 'Salt', 'Last_Login', 'Created_On'];
var AUTH_MAX_FAILS_ = 5;
var AUTH_LOCK_SECONDS_ = 15 * 60;
var AUTH_HASH_ROUNDS_ = 300;

function sessionSeconds_() {
  var h = Number(SETTINGS.SESSION_HOURS) || 6;
  return Math.max(600, Math.min(21600, Math.round(h * 3600)));
}

function normEmail_(e) { return String(e == null ? '' : e).trim().toLowerCase(); }

/* ------------------------------ users sheet ------------------------------ */

function getUsersSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SETTINGS.USERS_SHEET);
  if (!sh) {
    sh = ss.insertSheet(SETTINGS.USERS_SHEET);
    sh.getRange(1, 1, 1, USERS_HEADERS_.length).setValues([USERS_HEADERS_]).setFontWeight('bold');
    sh.setFrozenRows(1);
    try { sh.hideColumns(4, 2); } catch (e) { /* ignore */ }
  }
  return sh;
}

/** { row (1-based), email, name, active, hash, salt } or null */
function findUser_(email) {
  var target = normEmail_(email);
  if (!target) return null;
  var values = getUsersSheet_().getDataRange().getValues();
  for (var r = 1; r < values.length; r++) {
    if (normEmail_(values[r][0]) === target) {
      return { row: r + 1, email: target, name: String(values[r][1] || ''), active: yes_(values[r][2]),
               hash: String(values[r][3] || ''), salt: String(values[r][4] || '') };
    }
  }
  return null;
}

function hashPassword_(password, salt) {
  var h = salt + '|' + String(password);
  for (var i = 0; i < AUTH_HASH_ROUNDS_; i++) {
    h = Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + h, Utilities.Charset.UTF_8));
  }
  return h;
}

function randomPassword_() {
  var chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  var out = '';
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, Utilities.getUuid() + Date.now());
  for (var i = 0; i < 10; i++) out += chars.charAt((bytes[i] + 256) % chars.length);
  return out;
}

/* ------------------------------ sessions ------------------------------ */

function sessionKey_(token) { return 'sess_' + String(token || ''); }

/** Returns the session user {email, name} and extends it, or null. */
function checkSession_(token) {
  if (!token || String(token).length < 20) return null;
  var cache = CacheService.getScriptCache();
  var raw = cache.get(sessionKey_(token));
  if (!raw) return null;
  var s = JSON.parse(raw);
  // Re-check the USERS sheet at most every 10 minutes (a sheet read on every data call is slow).
  if (!s.chk || Date.now() - s.chk > 10 * 60 * 1000) {
    var u = findUser_(s.email);
    if (!u || !u.active) { cache.remove(sessionKey_(token)); return null; }  // disabled since login
    s.chk = Date.now(); raw = JSON.stringify(s);
  }
  cache.put(sessionKey_(token), raw, sessionSeconds_());
  return s;
}

/* -------------------- called from the page (google.script.run) -------------------- */

function authLogin(email, password) {
  try {
    var e = normEmail_(email);
    var cache = CacheService.getScriptCache();
    var failKey = 'fail_' + e;
    var fails = Number(cache.get(failKey) || 0);
    if (fails >= AUTH_MAX_FAILS_) return { ok: false, error: 'Too many wrong attempts. Try again in 15 minutes.' };

    var u = findUser_(e);
    var good = u && u.active && u.hash && hashPassword_(password, u.salt) === u.hash;
    if (!good) {
      cache.put(failKey, String(fails + 1), AUTH_LOCK_SECONDS_);
      return { ok: false, error: 'Email or password is wrong.' };
    }
    cache.remove(failKey);
    var token = Utilities.getUuid() + Utilities.getUuid();
    cache.put(sessionKey_(token), JSON.stringify({ email: u.email, name: u.name || u.email, chk: Date.now() }), sessionSeconds_());
    try { getUsersSheet_().getRange(u.row, 6).setValue(new Date()); } catch (x) { /* ignore */ }
    return { ok: true, token: token, name: u.name || u.email, email: u.email };
  } catch (err) {
    return { ok: false, error: 'Sign-in failed: ' + String(err && err.message || err) };
  }
}

function authCheck(token) {
  var s = checkSession_(token);
  return s ? { ok: true, name: s.name, email: s.email } : { ok: false };
}

function authLogout(token) {
  try { CacheService.getScriptCache().remove(sessionKey_(token)); } catch (e) { /* ignore */ }
  return { ok: true };
}

/* ------------------------------ sheet menu ------------------------------ */

/** Adds a user, or gives an existing user a new password. Emails the password. */
function addOrResetUser() {
  ownerOnly_();
  var ui = SpreadsheetApp.getUi();
  var r1 = ui.prompt('Add / reset user', 'Email of the person:', ui.ButtonSet.OK_CANCEL);
  if (r1.getSelectedButton() !== ui.Button.OK) return;
  var email = normEmail_(r1.getResponseText());
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { ui.alert('That does not look like an email address.'); return; }

  var existing = findUser_(email);
  var name = existing ? existing.name : '';
  if (!existing) {
    var r2 = ui.prompt('Add user', 'Name of the person:', ui.ButtonSet.OK_CANCEL);
    if (r2.getSelectedButton() !== ui.Button.OK) return;
    name = r2.getResponseText().trim();
  }

  var r3 = ui.prompt('Password for ' + email,
    'Type the password you want to give (min 6 characters),\nor leave it blank to create a random one:', ui.ButtonSet.OK_CANCEL);
  if (r3.getSelectedButton() !== ui.Button.OK) return;
  var password = String(r3.getResponseText() || '').trim();
  if (password && password.length < 6) { ui.alert('Password must be at least 6 characters. Nothing was changed.'); return; }
  if (!password) password = randomPassword_();
  var salt = Utilities.getUuid();
  var hash = hashPassword_(password, salt);
  var sh = getUsersSheet_();
  if (existing) {
    sh.getRange(existing.row, 3, 1, 3).setValues([['YES', hash, salt]]);
  } else {
    sh.appendRow([email, name, 'YES', hash, salt, '', new Date()]);
  }

  var WEB_LINK = 'https://sugam-grpnl.pages.dev';
  var GAS_LINK = 'https://script.google.com/macros/s/AKfycbzsiA2EVDAB6vLzLAyLDNIh7t4q3s9hEU9dYjC6Fn6MJt1RSwWsIyNaztjzrEBA6PO9kg/exec';
  var r4 = ui.prompt('Which link to send to ' + email + '?',
    'Type 1, 2 or 3:\n\n1 = Website  (' + WEB_LINK + ')   ← recommended\n2 = Apps Script link\n3 = Both links\n\n(Leave blank for 1)', ui.ButtonSet.OK_CANCEL);
  var pick = r4.getSelectedButton() === ui.Button.OK ? String(r4.getResponseText() || '').trim() : '1';
  var link = pick === '2' ? 'Link: ' + GAS_LINK
           : pick === '3' ? 'Link: ' + WEB_LINK + '\nBackup link: ' + GAS_LINK
           : 'Link: ' + WEB_LINK;
  var sent = false;
  try {
    MailApp.sendEmail({
      to: email,
      subject: 'Your access to the GR P&L Dashboard',
      body: 'Hello ' + (name || '') + ',\n\n' +
            'You now have access to the GR P&L Dashboard.\n\n' +
            link + '\n' +
            'Email: ' + email + '\n' +
            'Password: ' + password + '\n\n' +
            'Keep this password private. Ask the dashboard owner if you need a new one.\n'
    });
    sent = true;
  } catch (e) { /* show it instead */ }

  ui.alert((sent
    ? (existing ? 'New password emailed to ' : 'User added and password emailed to ') + email + '.'
    : 'Saved, but the email could not be sent. Give the password to ' + email + ' yourself.') +
    '\n\n' + link + '\nPassword: ' + password + '\n\n(Only you see this. It is not stored anywhere in readable form.)');
}

/** Turns a user off (they are signed out on their next data call). */
function disableUser() {
  ownerOnly_();
  var ui = SpreadsheetApp.getUi();
  var r = ui.prompt('Disable user', 'Email of the person to remove:', ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  var u = findUser_(r.getResponseText());
  if (!u) { ui.alert('No user with that email.'); return; }
  getUsersSheet_().getRange(u.row, 3).setValue('NO');
  ui.alert(u.email + ' can no longer open the dashboard.');
}
