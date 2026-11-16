/**
 * FILEREADER.GS
 * -------------
 * "Get Data from Folder": walks each source folder (and all subfolders),
 * finds new / changed files, opens them and returns raw header + rows.
 *
 * Requires: Apps Script editor → Services (+) → Drive API (v3).
 */

var EXCEL_MIMES_ = { // keys in lower case: Drive reports .xlsm as "...macroenabled.12"
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': true, // .xlsx
  'application/vnd.ms-excel': true,                                          // .xls
  'application/vnd.ms-excel.sheet.macroenabled.12': true,                    // .xlsm
  'application/vnd.ms-excel.sheet.binary.macroenabled.12': true              // .xlsb
};

function mimeLabel_(mime) {
  var m = String(mime || '');
  if (m === 'text/csv') return 'CSV';
  if (m === 'application/vnd.google-apps.shortcut') return 'shortcut';
  if (m === 'application/pdf') return 'PDF';
  if (m.indexOf('zip') >= 0) return 'ZIP';
  return m.replace(/^application\//, '');
}

var READER_BUILD_ = 'reader-2026-10-06.3';

/** Excel (.xlsx/.xls/.xlsm/.xlsb, any letter case) or a Google Sheet. */
function isAcceptedFile_(mime, fileType) {
  var m = String(mime || '').toLowerCase();
  var isGoogleSheet = m === 'application/vnd.google-apps.spreadsheet';
  var isExcel = !!EXCEL_MIMES_[m] || /spreadsheetml|ms-excel/.test(m);
  return isExcel || isGoogleSheet;
}

/**
 * Scans a source folder recursively.
 * Returns:
 *   pending: files that are new, modified, or were read with an older config/code version
 *   seen:    every file id currently in the folder (used to detect deleted files)
 */
function scanSourceFolder_(sourceConfig, manifest, signature) {
  var root = DriveApp.getFolderById(String(sourceConfig.Parent_Folder_ID).trim());

  var pattern = String(sourceConfig.File_Name_Pattern || '').trim();
  var regex = null;
  if (pattern && pattern.toUpperCase() !== 'TBD') {
    try { regex = new RegExp(pattern, 'i'); }
    catch (e) { throw new Error('Invalid File_Name_Pattern for ' + sourceConfig.Source_Code + ': ' + pattern); }
  }

  var out = { pending: [], seen: {}, seenCount: 0, skipped: [], files: [] };
  walkFolder_(root, root.getName(), regex, sourceConfig, manifest, signature, out);

  // Oldest first, so when the same key is in two files the newer file is applied last.
  out.pending.sort(function (a, b) { return a.lastUpdated.getTime() - b.lastUpdated.getTime(); });
  return out;
}

function walkFolder_(folder, pathLabel, regex, sourceConfig, manifest, signature, out) {
  var files = folder.getFiles();
  while (files.hasNext()) {
    var f = files.next();
    if (f.isTrashed()) continue;
    var name = f.getName();
    if (/^TEMP_CONVERT_/.test(name)) continue;
    var mime = f.getMimeType();
    var where = pathLabel + '/' + name;
    if (!isAcceptedFile_(mime, sourceConfig.File_Type)) {
      out.skipped.push(where + '  → not Excel/Google Sheet (' + mimeLabel_(mime) + ') [' + READER_BUILD_ + ']');
      out.files.push({ path: where, status: 'SKIPPED: ' + mimeLabel_(mime) + ' [' + READER_BUILD_ + ']' });
      continue;
    }
    if (regex && !regex.test(name)) {
      out.skipped.push(where + '  → name does not match File_Name_Pattern');
      out.files.push({ path: where, status: 'SKIPPED: name pattern' });
      continue;
    }

    var id = f.getId();
    var lastUpdated = f.getLastUpdated();
    out.seen[id] = true;
    out.seenCount++;

    var m = manifest.files[id];
    var isNew = !m;
    var isChanged = m && Number(m.lastUpdated) < lastUpdated.getTime();
    var configChanged = m && m.sig !== signature;
    out.files.push({ path: where, status: isNew ? 'NEW' : isChanged ? 'CHANGED' : configChanged ? 'RE-READ (config changed)' : 'already loaded' });

    if (isNew || isChanged || configChanged) {
      out.pending.push({
        fileId: id,
        fileName: name,
        mimeType: mime,
        lastUpdated: lastUpdated,
        folderPath: pathLabel
      });
    }
  }

  var subs = folder.getFolders();
  while (subs.hasNext()) {
    var sub = subs.next();
    if (sub.isTrashed()) continue;
    walkFolder_(sub, pathLabel + '/' + sub.getName(), regex, sourceConfig, manifest, signature, out);
  }
}

/**
 * Opens a file as a Spreadsheet. Excel files are converted to a temporary
 * Google Sheet inside the engine cache folder; call cleanupTempFile_ after reading.
 */
function openAsSpreadsheet_(file) {
  if (file.mimeType === MimeType.GOOGLE_SHEETS) {
    return { ss: SpreadsheetApp.openById(file.fileId), tempFileId: null };
  }
  var blob = DriveApp.getFileById(file.fileId).getBlob();
  var resource = {
    name: 'TEMP_CONVERT_' + file.fileId,
    mimeType: MimeType.GOOGLE_SHEETS,
    parents: [getCacheFolder_().getId()]
  };
  var temp = Drive.Files.create(resource, blob);
  return { ss: SpreadsheetApp.openById(temp.id), tempFileId: temp.id };
}

/** Permanently removes the temp conversion (falls back to trash). */
function cleanupTempFile_(tempFileId) {
  if (!tempFileId) return;
  try { Drive.Files.remove(tempFileId); }
  catch (e) { try { DriveApp.getFileById(tempFileId).setTrashed(true); } catch (e2) { /* ignore */ } }
}

/**
 * Finds the sheet + header row to read.
 *
 * System reports often have title / company / date lines above the real header,
 * or the data on a sheet other than the first. So instead of trusting only
 * Header_Row / Sheet_Name_Pattern, every candidate sheet's top 25 rows are scored
 * by how many configured column names (Source_Column or Output_Column) they contain,
 * and the best one wins. The configured sheet/row wins any tie.
 */
function locateHeader_(ss, sourceConfig, columnConfig) {
  var wanted = {};
  (columnConfig || []).forEach(function (c) {
    if (!String(c.Source_Column || '').trim()) return; // calculated column
    wanted[normName_(c.Source_Column)] = true;
    wanted[normName_(c.Output_Column)] = true;
  });

  var sheets = ss.getSheets();
  var wantedSheet = String(sourceConfig.Sheet_Name_Pattern || '').trim();
  var named = null;
  if (wantedSheet && wantedSheet.toUpperCase() !== 'TBD') {
    for (var i = 0; i < sheets.length; i++) {
      if (normName_(sheets[i].getName()) === normName_(wantedSheet)) { named = sheets[i]; break; }
    }
  }
  var candidates = named ? [named].concat(sheets.filter(function (s) { return s !== named; })) : sheets;
  var cfgRow = Number(sourceConfig.Header_Row) || 1;

  var best = null;
  candidates.forEach(function (sheet, si) {
    var lastRow = sheet.getLastRow(), lastCol = sheet.getLastColumn();
    if (lastRow < 1 || lastCol < 1) return;
    var top = sheet.getRange(1, 1, Math.min(lastRow, 25), lastCol).getValues();
    top.forEach(function (row, ri) {
      var score = 0;
      row.forEach(function (cell) { if (cell !== '' && wanted[normName_(cell)]) score++; });
      // tie-break: configured sheet first, then configured row
      var rank = score * 1000 + (si === 0 && named ? 10 : 0) + (ri + 1 === cfgRow ? 5 : 0);
      if (!best || rank > best.rank) best = { sheet: sheet, row: ri + 1, score: score, rank: rank };
    });
  });

  if (!best) throw new Error('File has no data (all sheets empty).');
  return best;
}

/**
 * Reads raw header + data rows. Data starts right after the header found,
 * keeping the configured gap (Data_Start_Row − Header_Row, usually 1).
 */
function readRawRows_(ss, sourceConfig, columnConfig) {
  var loc = locateHeader_(ss, sourceConfig, columnConfig);
  var sheet = loc.sheet;
  var cfgHeader = Number(sourceConfig.Header_Row) || 1;
  var gap = Math.max(1, (Number(sourceConfig.Data_Start_Row) || (cfgHeader + 1)) - cfgHeader);
  var headerRow = loc.row;
  var dataStartRow = headerRow + gap;

  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  var headers = sheet.getRange(headerRow, 1, 1, lastCol).getValues()[0]
    .map(function (h) { return String(h).trim(); });

  var note = (sheet.getName() !== String(sourceConfig.Sheet_Name_Pattern || '').trim() || headerRow !== cfgHeader)
    ? 'header found on sheet "' + sheet.getName() + '", row ' + headerRow : '';

  if (lastRow < dataStartRow) return { headers: headers, rows: [], note: note };
  var rows = sheet.getRange(dataStartRow, 1, lastRow - dataStartRow + 1, lastCol).getValues();
  return { headers: headers, rows: rows, note: note, sheetName: sheet.getName(), headerRow: headerRow };
}