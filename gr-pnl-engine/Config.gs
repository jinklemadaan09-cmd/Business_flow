/**
 * CONFIG.GS
 * ---------
 * Control sheets + engine settings.
 *
 * COLUMN_CONFIG convention:
 *   Source_Column filled = physical/raw source column
 *   Source_Column blank  = calculated column (Transformation = CALC_GP / CALC_GP_PERCENT)
 */

var SHEET_NAMES = {
  SOURCE_CONFIG: 'SOURCE_CONFIG',
  COLUMN_CONFIG: 'COLUMN_CONFIG',
  JOIN_CONFIG: 'JOIN_CONFIG',
  PROCESS_LOG: 'PROCESS_LOG',
  DASHBOARD_MASTER: 'DASHBOARD_MASTER'
};

/** Dashboard-facing mirror file (for people to look at; the dashboard itself reads the JSON). */
var MIRROR_FILE_ID = '1bX6umTLJ88weATME31MhC0SiGRinnLIF9cX9aIMOF2o';
var MIRROR_SHEET_NAME = 'DASHBOARD_MASTER';

var SETTINGS = {
  // Change this after any change to parsing logic. Every file's signature then
  // changes, so the next refresh re-reads all files automatically.
  CODE_VERSION: '2026-10-06.2',

  // DASHBOARD_MASTER sheets are only for people to look at — the dashboard reads
  // the JSON. Writing 60k+ rows takes minutes, so only ONE copy is written by default.
  WRITE_MIRROR_SHEET: true,   // write DASHBOARD_MASTER in the mirror file
  WRITE_LOCAL_MASTER: false,  // also write the DASHBOARD_MASTER tab in this control file
  SHEET_WRITE_MIN_TIME_LEFT_MS: 3 * 60 * 1000, // skip the sheet write this run if less time is left
  SHEET_MAX_CELLS: 9000000,   // Google Sheets hard limit is 10M per file

  MASTER_PART_ROWS: 15000,    // rows per JSON part on a full dashboard load

  // KG_TO_TON / RUPEES_TO_LACS (COLUMN_CONFIG → Transformation) are applied to the
  // DASHBOARD_MASTER SHEET that people read. The dashboard feed always stays in raw
  // kg / ₹, because yield = ₹ ÷ kg — feeding Lacs ÷ Tons would make every yield 100× off.
  // (Measured: converting 1.8 lakh rows in the browser takes ~30 ms — it is not the load.)
  SHEET_VIEW_UNITS: true,

  // NUMBER columns are rounded to the decimals in Display_Format ("0.00" → 2,
  // "0.00%" → 4). Blank Display_Format → DEFAULT_DECIMALS. Smaller payload, no noise.
  DEFAULT_DECIMALS: 2,

  // If XLSX → Google Sheet conversion turned dd-mm text into mm-dd dates
  // (only possible when day <= 12), detect it per file and swap back.
  DATE_AUTO_SWAP_FIX: true,

  AUTO_REFRESH_HOURS: 2,          // auto-refresh interval (any whole hours). Menu can turn it OFF (manual only)
  MAX_FILE_PHASE_MS: 4 * 60 * 1000, // stop opening new files after this; the rest continue next run
  MAX_DELTAS: 60,                   // incremental history kept for dashboard clients
  SHEET_WRITE_CHUNK_ROWS: 5000,

  // Output column names used by CALC_GP / CALC_GP_PERCENT
  GP_TOTAL_FREIGHT_COL: 'TOTAL FREIGHT',
  GP_TOTAL_EXPENSE_COL: 'TOTAL EXPENSE',

  CACHE_FOLDER_NAME: 'GR_PNL_ENGINE_CACHE',

  // Sign-in for the shared dashboard link (Auth.gs). Users are kept in the USERS sheet.
  REQUIRE_LOGIN: true,
  SESSION_HOURS: 6,          // max 6; extended on every data call
  USERS_SHEET: 'USERS',

  // Lanes.gs: who may save lane maps / target files for everyone from the dashboard.
  // The script owner always can; add more emails here, e.g. ['someone@sugamgroup.com'].
  LANE_EDITORS: [],

  // Reports.gs: finished decks / files (e.g. the monthly MRM PPT) that signed-in users can
  // download from the dashboard. Kept in this Drive folder; the script owner and LANE_EDITORS
  // can upload or remove them from the dashboard.
  REPORTS_FOLDER_NAME: 'GR_PNL_REPORTS',

  // NameGroups.gs: who may approve Consignor / Consignee / Customer name groups.
  // The script owner always can; add more emails here.
  NAME_APPROVERS: [],

  // Layout.gs: Pro mode admins, who may change and save the dashboard layout for everyone.
  // The script owner always can; add more emails here.
  DASH_ADMINS: ['jinklemadaan09@gmail.com']
};


/* ----------------------------- small helpers ----------------------------- */

function yes_(v) {
  return String(v == null ? '' : v).trim().toUpperCase() === 'YES';
}

function sameCode_(a, b) {
  return String(a == null ? '' : a).trim().toUpperCase() ===
         String(b == null ? '' : b).trim().toUpperCase();
}

/** "GR NO", "gr_no", "GrNo" → "grno" */
function normName_(s) {
  return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** One canonical string form for join / dedupe keys (101307686 === "101307686 " === "101307686.0") */
function normKey_(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') {
    if (!isFinite(v)) return '';
    return Math.abs(v - Math.round(v)) < 1e-9 ? String(Math.round(v)) : String(v);
  }
  var s = String(v).trim();
  if (/^\d+\.0+$/.test(s)) s = s.replace(/\.0+$/, '');
  return s;
}

function bySequence_(a, b) {
  return (Number(a.Sequence) || 0) - (Number(b.Sequence) || 0);
}


/* ----------------------------- sheet readers ----------------------------- */

/** Reads any control sheet as an array of objects (blank rows skipped). */
function readSheetAsObjects_(sheetName) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
  if (!sheet) throw new Error('Missing required config sheet: ' + sheetName);

  var values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];

  var headers = values[0].map(function (h) { return String(h).trim(); });
  var rows = [];
  for (var r = 1; r < values.length; r++) {
    var row = values[r];
    if (row.join('') === '') continue;
    var obj = {};
    for (var c = 0; c < headers.length; c++) {
      if (headers[c]) obj[headers[c]] = row[c];
    }
    rows.push(obj);
  }
  return rows;
}

/** Active sources ordered by Priority. */
function getActiveSources_() {
  var rows = readSheetAsObjects_(SHEET_NAMES.SOURCE_CONFIG)
    .filter(function (r) { return yes_(r.Active) && String(r.Source_Code || '').trim(); });

  var seen = {};
  rows.forEach(function (r) {
    r.Source_Code = String(r.Source_Code).trim();
    var k = r.Source_Code.toUpperCase();
    if (seen[k]) throw new Error('SOURCE_CONFIG: Source_Code "' + r.Source_Code + '" is listed twice.');
    seen[k] = true;
    if (!String(r.Parent_Folder_ID || '').trim()) {
      throw new Error('SOURCE_CONFIG: Parent_Folder_ID is empty for ' + r.Source_Code);
    }
  });

  return rows.sort(function (a, b) {
    return (Number(a.Priority) || 0) - (Number(b.Priority) || 0);
  });
}

/** All active + included columns (raw and calculated) for one source, in Sequence order. */
function getColumnConfigForSource_(sourceCode) {
  return readSheetAsObjects_(SHEET_NAMES.COLUMN_CONFIG)
    .filter(function (r) {
      return sameCode_(r.Source_Code, sourceCode) && yes_(r.Active) && yes_(r.Include) &&
             String(r.Output_Column || '').trim();
    })
    .sort(bySequence_);
}

/**
 * DASHBOARD_MASTER schema: Active + Include + Final_Include = YES,
 * ordered by source Priority, then Sequence. Also returns which columns are DATE.
 */
function getMasterSchemaInfo_() {
  var sources = getActiveSources_();
  var all = readSheetAsObjects_(SHEET_NAMES.COLUMN_CONFIG);
  var headers = [];
  var dateColumns = [];
  var divisors = {};
  var formats = {};
  var gpCols = [];
  var sourceNames = []; // Source_Column for each header ('' for calculated) — lets the dashboard map by raw name

  sources.forEach(function (src) {
    all.filter(function (r) {
      return sameCode_(r.Source_Code, src.Source_Code) &&
             yes_(r.Active) && yes_(r.Include) && yes_(r.Final_Include);
    })
    .sort(bySequence_)
    .forEach(function (r) {
      var out = String(r.Output_Column || '').trim();
      if (!out || headers.indexOf(out) !== -1) return;
      headers.push(out);
      sourceNames.push(String(r.Source_Column || '').trim());
      var type = String(r.Data_Type || '').trim().toUpperCase();
      var t = String(r.Transformation || '').trim().toUpperCase();
      if (type === 'DATE') dateColumns.push(out);
      var div = unitDivisor_(t);
      if (div) divisors[out] = div;
      if (t === 'CALC_GP') gpCols.push(out);
      // A "0.00" typed into the sheet can arrive as the number 0 — treat any number as "0.00".
      var fmt = typeof r.Display_Format === 'number' ? '0.00' : String(r.Display_Format || '').trim();
      if (fmt && type === 'NUMBER') formats[out] = fmt;
    });
  });

  // GP is TOTAL FREIGHT − TOTAL EXPENSE, so it is shown in the same unit as TOTAL FREIGHT.
  gpCols.forEach(function (c) {
    if (divisors[SETTINGS.GP_TOTAL_FREIGHT_COL]) divisors[c] = divisors[SETTINGS.GP_TOTAL_FREIGHT_COL];
  });

  return {
    headers: headers,
    dateColumns: dateColumns,
    sourceNames: sourceNames,
    sheetView: SETTINGS.SHEET_VIEW_UNITS ? { divisors: divisors, formats: formats } : { divisors: {}, formats: formats }
  };
}

function unitDivisor_(transformation) {
  var t = String(transformation || '').trim().toUpperCase();
  if (t === 'KG_TO_TON') return 1000;
  if (t === 'RUPEES_TO_LACS') return 100000;
  return 0;
}

/** Decimals to keep for a NUMBER column, from Display_Format ("0.00" → 2, "0.00%" → 4). */
function decimalsFor_(col) {
  var f = String(col.Display_Format == null ? '' : col.Display_Format).trim();
  var t = String(col.Transformation || '').trim().toUpperCase();
  if (t === 'CALC_GP_PERCENT') return 6;                // ratio: keep precision
  if (!f) return SETTINGS.DEFAULT_DECIMALS;
  var m = f.match(/\.([0#]+)/);
  var d = m ? m[1].length : 0;
  if (/%/.test(f)) d += 2;
  // Never fewer than DEFAULT_DECIMALS on raw kg / ₹ (a "0.00" written for Lacs still keeps paise).
  return Math.min(6, Math.max(d, SETTINGS.DEFAULT_DECIMALS));
}

function getMasterSchema_() {
  return getMasterSchemaInfo_().headers;
}

/** Active JOIN_CONFIG steps ordered by Step_No. */
function getActiveJoinSteps_() {
  return readSheetAsObjects_(SHEET_NAMES.JOIN_CONFIG)
    .filter(function (r) { return yes_(r.Active); })
    .sort(function (a, b) { return (Number(a.Step_No) || 0) - (Number(b.Step_No) || 0); });
}


/* ----------------------------- PROCESS_LOG ----------------------------- */
/* PROCESS_LOG is a human-readable log. Which files are pending is decided by
   the engine's own manifest (Cache.gs), not by this sheet.
   Any extra header you add (e.g. Raw_Rows, Bad_Date_Rows, Blank_Date_Rows,
   Date_Swapped_Rows) is filled automatically when the engine has that value. */

function getProcessLogSheet_() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAMES.PROCESS_LOG);
  if (!sheet) throw new Error('Missing required sheet: ' + SHEET_NAMES.PROCESS_LOG);
  return sheet;
}

/** Inserts or updates one PROCESS_LOG record (matched on File_ID). */
function upsertProcessLog_(entry) {
  var sheet = getProcessLogSheet_();
  var data = sheet.getDataRange().getValues();
  if (!data.length || data[0].join('') === '') throw new Error('PROCESS_LOG has no header row.');

  var headers = data[0].map(function (h) { return String(h).trim(); });
  var idCol = headers.indexOf('File_ID');
  if (idCol === -1) throw new Error('PROCESS_LOG is missing File_ID header.');

  var rowIndex = -1;
  for (var r = 1; r < data.length; r++) {
    if (String(data[r][idCol]) === String(entry.File_ID)) { rowIndex = r; break; }
  }

  var newRow = headers.map(function (h, i) {
    if (entry.hasOwnProperty(h)) return entry[h];
    return rowIndex === -1 ? '' : data[rowIndex][i];
  });

  if (rowIndex === -1) sheet.appendRow(newRow);
  else sheet.getRange(rowIndex + 1, 1, 1, newRow.length).setValues([newRow]);
}

/** Updates Status for several files in one write. */
function setProcessLogStatuses_(fileIds, status) {
  if (!fileIds || !fileIds.length) return;
  var sheet = getProcessLogSheet_();
  var data = sheet.getDataRange().getValues();
  var headers = data[0].map(function (h) { return String(h).trim(); });
  var idCol = headers.indexOf('File_ID');
  var statusCol = headers.indexOf('Status');
  if (idCol === -1 || statusCol === -1) throw new Error('PROCESS_LOG must contain File_ID and Status headers.');

  var wanted = {};
  fileIds.forEach(function (id) { wanted[String(id)] = true; });

  var col = [];
  for (var r = 1; r < data.length; r++) {
    col.push([wanted[String(data[r][idCol])] ? status : data[r][statusCol]]);
  }
  if (col.length) sheet.getRange(2, statusCol + 1, col.length, 1).setValues(col);
}

/** Clears PROCESS_LOG rows (keeps header). */
function clearProcessLog_() {
  var sheet = getProcessLogSheet_();
  if (sheet.getLastRow() > 1) {
    sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).clearContent();
  }
}
