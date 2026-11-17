/**
 * REPORTS.GS
 * ----------
 * Finished files (for example the monthly MRM deck) that signed-in dashboard users can download.
 * The files live in the Drive folder SETTINGS.REPORTS_FOLDER_NAME (created on first use).
 * Files can also be dropped into that folder by hand in Google Drive.
 *
 * Called by the page (google.script.run, or the website through doGet / doPost):
 *   reportsList(session)                         → { ok, canEdit, files:[{ id, name, size, updated, type }] }
 *   reportGet(session, id, offset)               → { ok, name, type, size, offset, next, b64 }  (in pieces)
 *   reportUpload(session, { uploadId, name, type, part, parts, b64 })   owner / LANE_EDITORS only
 *   reportDelete(session, id)                    owner / LANE_EDITORS only (moves the file to the Drive bin)
 */

var PROP_REPORTS_FOLDER_ = 'REPORTS_FOLDER_ID';
var REPORT_PIECE_BYTES_ = 3 * 1024 * 1024;          // download piece (≈4 MB as base64)
var REPORT_MAX_BYTES_ = 40 * 1024 * 1024;
var REPORT_TMP_PREFIX_ = '__upload_';

function getReportsFolder_() {
  var p = props_();
  var id = p.getProperty(PROP_REPORTS_FOLDER_);
  var f = folderByIdRestore_(id, 'reports'); // back out of the Trash if deleted by mistake
  if (f) return f;
  var name = SETTINGS.REPORTS_FOLDER_NAME || 'GR_PNL_REPORTS';
  var it = DriveApp.getFoldersByName(name), folder = null;
  while (it.hasNext()) { var c = it.next(); if (!c.isTrashed()) { folder = c; break; } }
  if (!folder) folder = getDataFolder_().createFolder(name);
  p.setProperty(PROP_REPORTS_FOLDER_, folder.getId());
  return folder;
}

/** The file, only when it sits in the reports folder (ids from elsewhere are refused). */
function reportFile_(id) {
  var folder = getReportsFolder_();
  var f = DriveApp.getFileById(String(id || ''));
  var parents = f.getParents();
  while (parents.hasNext()) if (parents.next().getId() === folder.getId()) {
    if (f.isTrashed()) break;
    return f;
  }
  throw new Error('File not found.');
}

function reportUser_(session) {
  var who = laneSessionUser_(session);
  if (who === false) throw new Error('LOGIN_REQUIRED');
  return who;
}

function reportsList(session) {
  try {
    var who = reportUser_(session);
    var files = [], it = getReportsFolder_().getFiles();
    while (it.hasNext()) {
      var f = it.next();
      if (f.isTrashed() || f.getName().indexOf(REPORT_TMP_PREFIX_) === 0) continue;
      if (String(f.getMimeType()).indexOf('application/vnd.google-apps') === 0) continue;   // Google Docs can't be sent as bytes
      files.push({ id: f.getId(), name: f.getName(), size: f.getSize(), updated: f.getLastUpdated().getTime(), type: f.getMimeType() });
    }
    files.sort(function (a, b) { return b.updated - a.updated; });
    return { ok: true, canEdit: laneCanEdit_(who), files: files };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
}

function reportGet(session, id, offset) {
  try {
    reportUser_(session);
    var f = reportFile_(id);
    var bytes = f.getBlob().getBytes();
    var start = Math.max(0, Number(offset) || 0), end = Math.min(bytes.length, start + REPORT_PIECE_BYTES_);
    return {
      ok: true, name: f.getName(), type: f.getMimeType(), size: bytes.length, offset: start,
      next: end < bytes.length ? end : -1,
      b64: Utilities.base64Encode(bytes.slice(start, end))
    };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
}

/**
 * Upload in pieces (each piece is one call): pieces are kept as temporary files in the
 * reports folder and joined when the last one arrives. A file with the same name is replaced.
 */
function reportUpload(session, payload) {
  try {
    var who = reportUser_(session);
    if (!laneCanEdit_(who)) return { ok: false, error: 'Only the dashboard owner can add files for everyone.' };
    payload = payload || {};
    var name = String(payload.name || '').replace(/[\\\/:*?"<>|]+/g, ' ').trim();
    var uid = String(payload.uploadId || '').replace(/[^A-Za-z0-9_-]/g, '');
    var part = Number(payload.part), parts = Number(payload.parts);
    if (!name || !uid || !(parts >= 1) || !(part >= 0) || part >= parts) return { ok: false, error: 'Bad upload request.' };
    var folder = getReportsFolder_();
    var bytes = Utilities.base64Decode(String(payload.b64 || ''));
    folder.createFile(Utilities.newBlob(bytes, 'application/octet-stream', REPORT_TMP_PREFIX_ + uid + '_' + part));
    if (part < parts - 1) return { ok: true, part: part };

    var lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try {
      var all = [], tmp = [], total = 0;
      for (var i = 0; i < parts; i++) {
        var it = folder.getFilesByName(REPORT_TMP_PREFIX_ + uid + '_' + i);
        if (!it.hasNext()) return { ok: false, error: 'Upload piece ' + (i + 1) + ' is missing — try again.' };
        var t = it.next(), b = t.getBlob().getBytes();
        total += b.length; if (total > REPORT_MAX_BYTES_) throw new Error('File is larger than 40 MB.');
        all = all.concat(b); tmp.push(t);
      }
      var old = folder.getFilesByName(name);
      while (old.hasNext()) old.next().setTrashed(true);
      var f = folder.createFile(Utilities.newBlob(all, String(payload.type || 'application/octet-stream'), name));
      tmp.forEach(function (x) { x.setTrashed(true); });
      return { ok: true, done: true, id: f.getId(), name: name };
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
}

function reportDelete(session, id) {
  try {
    var who = reportUser_(session);
    if (!laneCanEdit_(who)) return { ok: false, error: 'Only the dashboard owner can remove files.' };
    reportFile_(id).setTrashed(true);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
}
