/**
 * TRANSFORM.GS
 * ------------
 * Config-driven transformation engine.
 *
 * Dates are stored everywhere as ISO text "yyyy-MM-dd". It is unambiguous,
 * sorts correctly, never depends on locale, and the dashboard reads it directly.
 *
 * Supported Transformation values:
 *   SML_TO_LTL                  stored in the data
 *   GST_TO_PAN                  stored: MID(GST no., 3, 10) = the PAN, e.g. 07AAWPF1646F1ZM → AAWPF1646F
 *                               (blank when the result is not a valid PAN, e.g. Nepal VAT no. or "EX")
 *   CALC_GP, CALC_GP_PERCENT    calculated columns (Source_Column blank), stored in the data
 *   KG_TO_TON, RUPEES_TO_LACS   DASHBOARD_MASTER sheet view only (dashboard feed stays kg / ₹)
 *
 * NUMBER columns are rounded to the decimals of Display_Format (see decimalsFor_).
 */

var MONTHS_3_ = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];


/* ------------------------------ dates ------------------------------ */

function pad2_(n) { return (n < 10 ? '0' : '') + n; }

/** Builds "yyyy-MM-dd" only if it is a real calendar date, else ''. */
function isoFromParts_(y, m, d) {
  y = Number(y); m = Number(m); d = Number(d);
  if (!(y >= 1900 && y <= 2100) || !(m >= 1 && m <= 12) || !(d >= 1 && d <= 31)) return '';
  var t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return '';
  return y + '-' + pad2_(m) + '-' + pad2_(d);
}

/**
 * Strict date parser — NEVER uses new Date("string") (that assumes US mm-dd).
 * Accepts: Date objects, Excel serial numbers, dd-mm-yyyy / dd/mm/yyyy / dd.mm.yyyy,
 * dd-mm-yy, yyyy-mm-dd, dd-MMM-yyyy (01-Apr-2026), with or without a time part.
 * Returns "yyyy-MM-dd" or '' if not a valid date.
 */
function toIsoDate_(v, tz) {
  if (v === null || v === undefined || v === '') return '';

  if (v instanceof Date) {
    if (isNaN(v.getTime())) return '';
    return Utilities.formatDate(v, tz || Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }

  if (typeof v === 'number') {
    if (v > 1 && v < 100000) { // Excel serial
      var ms = Math.round((v - 25569) * 86400000);
      return Utilities.formatDate(new Date(ms), 'UTC', 'yyyy-MM-dd');
    }
    return '';
  }

  var s = String(v).trim();
  var m;

  m = s.match(/^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})(?:\D|$)/);
  if (m) return isoFromParts_(m[1], m[2], m[3]);

  m = s.match(/^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{4}|\d{2})(?:\D|$)/);
  if (m) {
    var y = Number(m[3]);
    if (y < 100) y += 2000;
    return isoFromParts_(y, m[2], m[1]); // day FIRST — Indian format
  }

  m = s.match(/^(\d{1,2})[-\s\/.]([A-Za-z]{3,9})[-\s\/.,]+(\d{4}|\d{2})(?:\D|$)/);
  if (m) {
    var mi = MONTHS_3_.indexOf(m[2].slice(0, 3).toLowerCase());
    if (mi < 0) return '';
    var yy = Number(m[3]);
    if (yy < 100) yy += 2000;
    return isoFromParts_(yy, mi + 1, m[1]);
  }

  return '';
}

/**
 * Detects the XLSX-conversion bug: dd-mm text with day <= 12 became a real
 * (wrong) mm-dd Date, while day > 12 stayed as text. Signal = the column has
 * Date objects whose day is never > 12, AND text dates whose first part is > 12.
 */
function needsDaySwap_(rows, colIdx, tz) {
  var dateObjects = 0, maxDay = 0, bigDayStrings = 0;
  for (var i = 0; i < rows.length; i++) {
    var v = rows[i][colIdx];
    if (v instanceof Date && !isNaN(v.getTime())) {
      dateObjects++;
      var d = Number(Utilities.formatDate(v, tz, 'd'));
      if (d > maxDay) maxDay = d;
      if (maxDay > 12) return false; // genuine dates present
    } else if (typeof v === 'string') {
      var m = v.trim().match(/^(\d{1,2})[-\/.](\d{1,2})[-\/.]\d{2,4}/);
      if (m && Number(m[1]) > 12) bigDayStrings++;
    }
  }
  return dateObjects > 0 && bigDayStrings > 0 && maxDay <= 12;
}

function swappedIsoDate_(d, tz) {
  var p = Utilities.formatDate(d, tz, 'yyyy-M-d').split('-');
  return isoFromParts_(p[0], p[2], p[1]); // month ↔ day
}


/* ------------------------------ values ------------------------------ */

function round6_(n) { return Math.round(n * 1e6) / 1e6; }

function roundTo_(n, d) {
  var f = Math.pow(10, d);
  var r = Math.round(n * f) / f;
  return r === 0 ? 0 : r; // no "-0"
}

/** 125000 | "125000" | "1,25,000" | "₹1,25,000" | "(1,200)" → number; blank/invalid → 0 */
function parseNumericValue_(value) {
  if (value === null || value === undefined || value === '') return 0;
  if (typeof value === 'number') return isNaN(value) ? 0 : value;
  var s = String(value).replace(/[,₹\s]/g, '').trim();
  var neg = /^\(.*\)$/.test(s);
  if (neg) s = s.slice(1, -1);
  var n = Number(s);
  if (isNaN(n)) return 0;
  return neg ? -n : n;
}

function castValue_(v, type) {
  if (type === 'NUMBER') return round6_(parseNumericValue_(v));
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return toIsoDate_(v);
  return String(v).trim();
}

/**
 * Row-level transformations stored in the data.
 * KG_TO_TON / RUPEES_TO_LACS are NOT applied here: they are a view setting,
 * applied when the DASHBOARD_MASTER sheet is written (see writeTableToSheet_).
 */
function applyTransform_(v, transformation) {
  var t = String(transformation || '').trim().toUpperCase();
  if (t === 'SML_TO_LTL') {
    return String(v).trim().toUpperCase() === 'SML' ? 'LTL' : v;
  }
  if (t === 'GST_TO_PAN') {
    var pan = String(v == null ? '' : v).replace(/\s+/g, '').toUpperCase().substr(2, 10);
    return /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(pan) ? pan : '';
  }
  return v;
}


/* ------------------------------ mapping ------------------------------ */

/** Header lookup: exact (case-insensitive) first, then ignoring spaces/symbols. */
function buildHeaderIndex_(rawHeaders) {
  var exact = {}, loose = {};
  rawHeaders.forEach(function (h, i) {
    var e = String(h).trim().toLowerCase();
    var l = normName_(h);
    if (e && !exact.hasOwnProperty(e)) exact[e] = i;
    if (l && !loose.hasOwnProperty(l)) loose[l] = i;
  });
  return function (name) {
    var e = String(name).trim().toLowerCase();
    if (exact.hasOwnProperty(e)) return exact[e];
    var l = normName_(name);
    return loose.hasOwnProperty(l) ? loose[l] : -1;
  };
}

function isBlankRow_(row) {
  for (var i = 0; i < row.length; i++) {
    if (row[i] !== '' && row[i] !== null && row[i] !== undefined) return false;
  }
  return true;
}

/**
 * Raw rows → records keyed by Output_Column, per COLUMN_CONFIG.
 * tz = time zone of the spreadsheet the values were read from.
 * Returns { records, stats: { blankRows, badDate, dateSwapped } }.
 */
function applyColumnConfig_(rawHeaders, rawRows, columnConfig, sourceCode, fileName, tz) {
  tz = tz || Session.getScriptTimeZone();
  var find = buildHeaderIndex_(rawHeaders);

  var physical = columnConfig.filter(function (c) {
    return String(c.Source_Column || '').trim() && String(c.Output_Column || '').trim();
  });

  // A column with a Default_Value is OPTIONAL: files that don't have it (e.g. older
  // reports, before the column was added) get the default instead of an error.
  var hasDefault = function (c) {
    return c.Default_Value !== undefined && c.Default_Value !== null && String(c.Default_Value).trim() !== '';
  };
  var missing = [];
  var optionalMissing = [];
  var idx = physical.map(function (c) {
    var i = find(c.Source_Column);
    if (i < 0) i = find(c.Output_Column); // file already uses the output name (e.g. "TOTAL FREIGHT")
    if (i < 0) {
      if (hasDefault(c)) optionalMissing.push(String(c.Source_Column).trim());
      else missing.push(String(c.Source_Column).trim());
    }
    return i;
  });
  if (missing.length) {
    var seen = rawHeaders.filter(function (h) { return String(h).trim(); });
    throw new Error('Missing configured column(s) — Source: ' + sourceCode +
      ', File: ' + fileName + ', Missing: ' + missing.join(', ') +
      ' || Headers in file: ' + (seen.length ? seen.slice(0, 15).join(', ') + (seen.length > 15 ? ' …' : '') : '(none found)'));
  }

  var types = physical.map(function (c) { return String(c.Data_Type || 'TEXT').trim().toUpperCase(); });
  var decimals = physical.map(function (c) { return decimalsFor_(c); });

  var swapCol = {};
  if (SETTINGS.DATE_AUTO_SWAP_FIX) {
    physical.forEach(function (c, j) {
      if (types[j] === 'DATE' && idx[j] >= 0 && needsDaySwap_(rawRows, idx[j], tz)) swapCol[j] = true;
    });
  }

  var stats = { blankRows: 0, badDate: 0, dateSwapped: 0, optionalMissing: optionalMissing };
  var records = [];

  rawRows.forEach(function (row) {
    if (isBlankRow_(row)) { stats.blankRows++; return; }
    var out = {};

    physical.forEach(function (c, j) {
      var outName = String(c.Output_Column).trim();
      var v = idx[j] >= 0 ? row[idx[j]] : '';
      if (v === '' || v === null || v === undefined || (typeof v === 'string' && v.trim() === '')) {
        v = (c.Default_Value !== undefined && c.Default_Value !== null && c.Default_Value !== '')
          ? c.Default_Value : '';
      }

      if (types[j] === 'DATE') {
        var iso;
        if (swapCol[j] && v instanceof Date) { iso = swappedIsoDate_(v, tz); stats.dateSwapped++; }
        else iso = toIsoDate_(v, tz);
        if (v !== '' && !iso) stats.badDate++;
        out[outName] = iso;
      } else if (types[j] === 'NUMBER') {
        out[outName] = roundTo_(parseNumericValue_(v), decimals[j]);
      } else {
        out[outName] = applyTransform_(castValue_(v, types[j]), c.Transformation);
      }
    });

    records.push(out);
  });

  return { records: records, stats: stats };
}


/* -------------------------- calculated columns -------------------------- */

/** GP = TOTAL FREIGHT − TOTAL EXPENSE ;  GP% = GP / TOTAL FREIGHT (decimal, 0.20 = 20%) */
function addCalculatedFields_(records, columnConfig) {
  var calc = columnConfig.filter(function (c) {
    var t = String(c.Transformation || '').trim().toUpperCase();
    return !String(c.Source_Column || '').trim() && (t === 'CALC_GP' || t === 'CALC_GP_PERCENT');
  });
  if (!calc.length) return records;

  records.forEach(function (rec) {
    var tf = parseNumericValue_(rec[SETTINGS.GP_TOTAL_FREIGHT_COL]);
    var te = parseNumericValue_(rec[SETTINGS.GP_TOTAL_EXPENSE_COL]);
    var gp = tf - te;
    var gpp = tf !== 0 ? gp / tf : 0;
    calc.forEach(function (c) {
      var out = String(c.Output_Column || '').trim();
      var t = String(c.Transformation).trim().toUpperCase();
      if (!out) return;
      rec[out] = roundTo_(t === 'CALC_GP' ? gp : gpp, decimalsFor_(c));
    });
  });
  return records;
}


/* ------------------------- names, keys, dedupe ------------------------- */

/**
 * JOIN_CONFIG / SOURCE_CONFIG may name a column by its raw name (grno),
 * its output name (GR NO) or loosely (GRNO). Returns the Output_Column.
 */
function resolveOutputColumnName_(sourceCode, columnName, columnConfigCache) {
  var name = String(columnName == null ? '' : columnName).trim();
  if (!name) return '';
  var cfg = columnConfigCache[sourceCode];
  if (!cfg) return name;

  var target = normName_(name);
  for (var i = 0; i < cfg.length; i++) {
    if (String(cfg[i].Source_Column || '').trim() && normName_(cfg[i].Source_Column) === target) {
      return String(cfg[i].Output_Column).trim();
    }
  }
  for (var j = 0; j < cfg.length; j++) {
    if (normName_(cfg[j].Output_Column) === target) return String(cfg[j].Output_Column).trim();
  }
  return name;
}

/**
 * One record per key. Records must be passed oldest-file-first.
 * Both dates present → later date wins; otherwise / on a tie → later record wins.
 * Key values are normalised in place (normKey_). Blank keys are dropped.
 */
function dedupeRecords_(records, keyOutputCol, dateOutputCol, maxOutputCol) {
  var byKey = new Map();
  records.forEach(function (rec) {
    var key = normKey_(rec[keyOutputCol]);
    if (!key) return;
    rec[keyOutputCol] = key;
    var existing = byKey.get(key);
    if (existing && !dedupeWins_(rec, existing, dateOutputCol, maxOutputCol)) return;
    byKey.set(key, rec);
  });
  return Array.from(byKey.values());
}

/**
 * Which of two duplicate rows is kept:
 *   MAX:<column> rule → the higher value of that column; equal values fall through
 *   then the newer Date_Column value; equal dates → the row read later wins.
 */
function dedupeWins_(rec, existing, dateCol, maxCol) {
  if (maxCol) {
    var a = Number(rec[maxCol]), b = Number(existing[maxCol]);
    var an = isFinite(a) && String(rec[maxCol]).trim() !== '', bn = isFinite(b) && String(existing[maxCol]).trim() !== '';
    if (an && !bn) return true;
    if (!an && bn) return false;
    if (an && bn && a !== b) return a > b;
  }
  if (dateCol) {
    var nd = String(rec[dateCol] || ''), od = String(existing[dateCol] || '');
    if (nd && od && nd < od) return false;
  }
  return true;
}

/** "MAX:RATE", "MAX(RATE)" or "MAX RATE" → the column name; anything else → '' */
function maxRuleColumn_(rule) {
  var m = String(rule || '').trim().match(/^MAX\s*[:(\s]\s*([^)]+?)\s*\)?$/i);
  return m ? m[1].trim() : '';
}

/**
 * Columns filled from the file's folder, e.g. COMPANY:
 *   GR CHARGES PNL DATA / PARIVAHAN / 2026-27 / file.xlsx  →  PARIVAHAN
 * COLUMN_CONFIG row: Source_Column blank, Transformation = FOLDER_NAME
 * (first subfolder under the source's Parent folder).
 */
function addFolderFields_(records, columnConfig, folderPath) {
  var cols = columnConfig.filter(function (c) {
    var t = String(c.Transformation || '').trim().toUpperCase();
    return !String(c.Source_Column || '').trim() && t === 'FOLDER_NAME' && String(c.Output_Column || '').trim();
  });
  if (!cols.length) return records;
  var parts = String(folderPath || '').split('/').map(function (s) { return s.trim(); }).filter(Boolean);
  var name = parts.length > 1 ? String(parts[1]).toUpperCase() : '';
  records.forEach(function (rec) {
    cols.forEach(function (c) { rec[String(c.Output_Column).trim()] = name; });
  });
  return records;
}