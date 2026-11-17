/**
 * MAIN.GS
 * -------
 * refreshDashboardIncremental()  everyday function (run by the 15-min trigger).
 *   Reads ONLY new / modified / removed files, recomputes ONLY the affected
 *   GR rows, writes the master JSON + a small delta for the dashboard.
 *
 * rebuildDashboardFull()  clean slate: wipes engine storage and PROCESS_LOG,
 *   then reprocesses every file. Use once after installing this version,
 *   and for recovery.
 *
 * Long runs are safe: file reading stops after SETTINGS.MAX_FILE_PHASE_MS and
 * the remaining files are picked up on the next run.
 */

function onOpen() {
  SpreadsheetApp.getUi().createMenu('GR PNL Engine')
    .addItem('Refresh now (incremental)', 'refreshDashboardIncremental')
    .addItem('Rebuild master from cache (no files re-read)', 'rebuildMasterFromCache')
    .addItem('Full rebuild (clean slate)', 'rebuildDashboardFull')
    .addItem('Rewrite master sheets from JSON', 'rewriteMasterSheets')
    .addSeparator()
    .addItem('Check folders (which files are seen)', 'debugFolders')
    .addSubMenu(SpreadsheetApp.getUi().createMenu('Dashboard data folder')
      .addItem('Move engine files into GR_DASHBOARD_DATA now', 'setupDashboardDataFolder')
      .addItem('Open dashboard data folder', 'openDashboardDataFolder'))
    .addItem('Check one GR (where is it, what got merged)', 'debugGr')
    .addItem('Check joins (how many GRs matched per step)', 'debugJoin')
    .addItem('Check date column (diagnostic)', 'debugDateColumn')
    .addItem('Set API token', 'setApiTokenFromMenu')
    .addSubMenu(SpreadsheetApp.getUi().createMenu('Users (dashboard sign-in)')
      .addItem('Add / reset user (emails password)', 'addOrResetUser')
      .addItem('Disable user', 'disableUser'))
    .addSubMenu(SpreadsheetApp.getUi().createMenu('Lanes & targets')
      .addItem('Create lane sheets (LANE_ORIGIN, LANE_DEST, LANE_TARGETS)', 'setupLaneSheets')
      .addItem('Send sheet edits to the dashboard now', 'refreshLaneCache'))
    .addSubMenu(SpreadsheetApp.getUi().createMenu('Name groups')
      .addItem('Send NAME_GROUPS edits to the dashboard now', 'refreshNameGroupsCache'))
    .addItem('Auto-refresh ON (every ' + (Number(SETTINGS.AUTO_REFRESH_HOURS) || 3) + ' hours)', 'autoRefreshOn')
    .addItem('Auto-refresh OFF (manual only)', 'autoRefreshOff')
    .addSubMenu(GRA_menu_(SpreadsheetApp.getUi()))
    .addSubMenu(CA_menu_(SpreadsheetApp.getUi()))
    .addToUi();
}

function refreshDashboardIncremental() {
  ensureAutoRefresh_();
  return withLock_(function () { return runIncrementalRefresh_(); });
}

/** One-off follow-up run, scheduled when a run stopped with files still pending. */
function continueRefresh() {
  removeTriggers_('continueRefresh');
  return refreshDashboardIncremental();
}

function rebuildDashboardFull() {
  ownerOnly_();
  ensureAutoRefresh_();
  return withLock_(function () {
    resetEngineStorage_();
    deleteLegacyCacheSheets_();
    clearProcessLog_();
    return runIncrementalRefresh_();
  });
}

/** Rewrites DASHBOARD_MASTER sheet(s) from the current master JSON. */
function rewriteMasterSheets() {
  ownerOnly_();
  ensureAutoRefresh_();
  return withLock_(function () {
    var state = loadState_();
    if (!hasMaster_(state)) { show_('No master yet — run Refresh first.'); return; }
    var ok = writeMasterSheets_(state, true, Date.now());
    show_(ok ? 'DASHBOARD_MASTER rewritten: ' + state.rowCount + ' rows.'
             : 'Sheet write skipped or failed — see View → Executions / Logs.');
  });
}

/**
 * Admin functions are public (the menu needs them), so a viewer of the shared
 * dashboard link could otherwise call them through google.script.run.
 *  - From the sheet MENU: always allowed (only people who can edit the sheet see it).
 *    Detected by SpreadsheetApp.getUi(), which only works in that context.
 *  - From anywhere else (dashboard link, editor ▶ Run): only the script owner.
 * refreshDashboardIncremental stays open: harmless, and the time trigger uses it.
 */
function ownerOnly_() {
  try { SpreadsheetApp.getUi(); return; } catch (e) { /* not the sheet menu */ }
  var active = '', owner = '';
  try { active = Session.getActiveUser().getEmail(); } catch (e) {}
  try { owner = Session.getEffectiveUser().getEmail(); } catch (e) {}
  if (active && owner && active.toLowerCase() === owner.toLowerCase()) return;
  throw new Error('This can only be run from the sheet menu (GR PNL Engine) or by the script owner.');
}

/* ============================ automatic triggers ============================ */

function removeTriggers_(handler) {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === handler) ScriptApp.deleteTrigger(t);
  });
}

/* Auto-refresh: an hourly trigger wakes scheduledRefresh(), which only does the
   work when AUTO_REFRESH_HOURS have passed (Google triggers can't do "every 3 hours").
   Menu: "Auto-refresh ON" / "Auto-refresh OFF (manual only)". */

function autoRefreshHours_() {
  var p = props_().getProperty('AUTO_REFRESH_HOURS');
  if (p !== null && p !== '') return Number(p) || 0;
  return Number(SETTINGS.AUTO_REFRESH_HOURS) || 0;
}

/** Called by the hourly trigger. */
function scheduledRefresh() {
  var hours = autoRefreshHours_();
  if (!hours) { removeTriggers_('scheduledRefresh'); return 'Auto-refresh is OFF.'; }
  var last = Number(props_().getProperty('LAST_AUTO_REFRESH') || 0);
  if (Date.now() - last < hours * 3600000 - 10 * 60000) return 'Not due yet.';
  props_().setProperty('LAST_AUTO_REFRESH', String(Date.now()));
  return withLock_(function () { return runIncrementalRefresh_(); });
}

/**
 * Keeps the trigger in line with the setting. Called by every menu action, so the
 * first menu click installs it. Also removes the old every-15-min trigger.
 * Silent where triggers can't be managed (e.g. the dashboard link).
 */
function ensureAutoRefresh_() {
  try {
    removeTriggers_('refreshDashboardIncremental'); // old style (every 15 min)
    var hours = autoRefreshHours_();
    var has = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'scheduledRefresh'; });
    if (!hours) { if (has) removeTriggers_('scheduledRefresh'); return; }
    if (!has) {
      ScriptApp.newTrigger('scheduledRefresh').timeBased().everyHours(1).create();
      props_().setProperty('LAST_AUTO_REFRESH', String(Date.now()));
    }
  } catch (e) { /* no permission in this context — ignore */ }
}

function autoRefreshOn() {
  ownerOnly_();
  props_().deleteProperty('AUTO_REFRESH_HOURS'); // back to Config value
  ensureAutoRefresh_();
  show_('Auto-refresh ON: every ' + autoRefreshHours_() + ' hour(s). Change the interval in Config.gs → AUTO_REFRESH_HOURS.');
}

function autoRefreshOff() {
  ownerOnly_();
  props_().setProperty('AUTO_REFRESH_HOURS', '0');
  removeTriggers_('scheduledRefresh');
  removeTriggers_('refreshDashboardIncremental');
  show_('Auto-refresh OFF. Use "Refresh now" whenever you add files.');
}

/** Run again in ~1 minute (used when files are still pending). */
function scheduleContinuation_() {
  try {
    removeTriggers_('continueRefresh');
    ScriptApp.newTrigger('continueRefresh').timeBased().after(60 * 1000).create();
  } catch (e) { /* the 15-minute refresh will pick it up anyway */ }
}

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) {
    Logger.log('Another refresh is already running — try again shortly.');
    return null;
  }
  try { return fn(); } finally { lock.releaseLock(); }
}


/* ============================== the engine ============================== */

function runIncrementalRefresh_() {
  var t0 = Date.now();
  try { ensureDataFolderLayout_(false); } catch (e) { Logger.log('Dashboard data folder: ' + e.message); } // one-time move, ids stay the same
  var state = loadState_();
  var sources = getActiveSources_();
  if (!sources.length) throw new Error('No Active source in SOURCE_CONFIG.');

  var cfgCache = {};
  sources.forEach(function (src) { cfgCache[src.Source_Code] = getColumnConfigForSource_(src.Source_Code); });

  var affected = Object.assign({}, state.pendingKeys || {}); // carry over keys from a failed run
  var cachedFileIds = [];
  var stoppedEarly = false;
  var fileErrors = 0;
  var scanNotes = [];
  var changedSources = {}; // sources with a new / changed / removed file this run

  /* ---------- 1. read new / changed / removed files into the cache ---------- */
  sources.forEach(function (src) {
    if (stoppedEarly) return;
    var code = src.Source_Code;
    var cfg = cfgCache[code];
    var keyCol = sourceKeyCol_(code, src.Unique_Key, cfgCache);
    var dateCol = resolveOutputColumnName_(code, src.Date_Column, cfgCache);
    if (!keyCol) throw new Error('SOURCE_CONFIG: Unique_Key is empty for ' + code);

    var sig = configSignature_(src, cfg);
    var man = state.sources[code] = state.sources[code] || { files: {} };
    var scan = scanSourceFolder_(src, man, sig);
    scanNotes.push(code + ': ' + scan.seenCount + ' file(s) found, ' + scan.pending.length + ' new/changed' +
      (scan.skipped.length ? ', skipped: ' + scan.skipped.slice(0, 3).join('; ') + (scan.skipped.length > 3 ? ' …' : '') : ''));

    // Files deleted / moved out of the folder → their rows leave the master
    Object.keys(man.files).forEach(function (fid) {
      if (scan.seen[fid]) return;
      var m = man.files[fid];
      try { readFileCacheKeys_(m.cacheId, keyCol).forEach(function (k) { affected[k] = true; }); } catch (e) { /* ignore */ }
      trashFileQuiet_(m.cacheId);
      delete man.files[fid];
      changedSources[code] = true;
      upsertProcessLog_({
        File_ID: fid, File_Name: m.fileName, Source_Code: code,
        Processed_Time: new Date(), Row_Count: 0, Status: 'REMOVED',
        Error_Message: 'File no longer in folder — its rows were removed'
      });
    });

    for (var i = 0; i < scan.pending.length; i++) {
      if (Date.now() - t0 > SETTINGS.MAX_FILE_PHASE_MS) { stoppedEarly = true; break; }
      var file = scan.pending[i];
      var opened = null;
      try {
        opened = openAsSpreadsheet_(file);
        var raw = readRawRows_(opened.ss, src, cfg);
        var res = applyColumnConfig_(raw.headers, raw.rows, cfg, code, file.fileName,
                                     opened.ss.getSpreadsheetTimeZone());
        var recs = addCalculatedFields_(res.records, cfg);
        addFolderFields_(recs, cfg, file.folderPath);
        var rawCount = recs.length;
        var rf = applyRowFilter_(recs, src, cfgCache);
        recs = rf.records;
        addCompositeKey_(recs, code, src.Unique_Key, cfgCache);
        recs = dedupeRecords_(recs, keyCol, dateCol, sourceMaxCol_(src, cfgCache));

        var old = man.files[file.fileId];
        if (old) readFileCacheKeys_(old.cacheId, keyCol).forEach(function (k) { affected[k] = true; });

        var cols = uniqueOutputColumns_(cfg);
        if (keyCol === COMPOSITE_KEY_ && cols.indexOf(COMPOSITE_KEY_) < 0) cols = cols.concat([COMPOSITE_KEY_]);
        var rows = recs.map(function (r) {
          return cols.map(function (c) { return r[c] === undefined ? '' : r[c]; });
        });
        var cacheId = writeFileCache_(code, file.fileId, cols, rows, old && old.cacheId);
        recs.forEach(function (r) { affected[normKey_(r[keyCol])] = true; });

        man.files[file.fileId] = {
          cacheId: cacheId, fileName: file.fileName,
          lastUpdated: file.lastUpdated.getTime(), sig: sig, rows: recs.length
        };

        var blankDate = dateCol ? recs.filter(function (r) { return !r[dateCol]; }).length : '';
        upsertProcessLog_({
          File_ID: file.fileId, File_Name: file.fileName, Source_Code: code,
          Folder_Path: file.folderPath, Last_Updated: file.lastUpdated, Processed_Time: new Date(),
          Raw_Rows: rawCount, Row_Count: recs.length,
          Bad_Date_Rows: res.stats.badDate, Blank_Date_Rows: blankDate,
          Date_Swapped_Rows: res.stats.dateSwapped,
          Status: 'CACHED',
          Error_Message: [raw.note ? 'OK — ' + raw.note : '',
                          rf.dropped ? 'Row_Filter kept ' + recs.length + ', left out ' + rf.dropped : '',
                          res.stats.optionalMissing.length ? 'Not in this file (default used): ' + res.stats.optionalMissing.join(', ') : '']
                         .filter(Boolean).join(' | ')
        });
        cachedFileIds.push(file.fileId);
        changedSources[code] = true;
      } catch (err) {
        fileErrors++;
        upsertProcessLog_({
          File_ID: file.fileId, File_Name: file.fileName, Source_Code: code,
          Folder_Path: file.folderPath, Last_Updated: file.lastUpdated, Processed_Time: new Date(),
          Row_Count: 0, Status: 'ERROR', Error_Message: String(err && err.message || err)
        });
      } finally {
        if (opened) cleanupTempFile_(opened.tempFileId);
      }
    }
  });

  delete affected[''];
  state.pendingKeys = affected;
  saveState_(state); // manifest + pending keys persisted BEFORE building the master

  /* ---------- 2. decide what to recompute ---------- */
  var schema = getMasterSchemaInfo_();
  var baseName = getBaseDatasetName_(sources);
  var baseSrc = sources.filter(function (s) { return s.Source_Code === baseName; })[0];
  if (!baseSrc) throw new Error('Base dataset "' + baseName + '" (first JOIN_CONFIG step) is not an Active source.');
  var keyField = resolveOutputColumnName_(baseName, baseSrc.Unique_Key, cfgCache);
  if (schema.headers.indexOf(keyField) === -1) {
    throw new Error('Key column "' + keyField + '" must have Final_Include = YES in COLUMN_CONFIG.');
  }

  var fullRecompute = !hasMaster_(state) ||
    JSON.stringify(state.headers) !== JSON.stringify(schema.headers) ||
    state.keyColumn !== keyField ||
    lookupSourceChanged_(changedSources, baseName, keyField, cfgCache) ||
    state.joinDefaultsSig !== joinDefaultsSignature_(cfgCache);   // a Default_Value was added/changed

  // Ton/Lacs or Display_Format changed → only the sheet view needs rewriting, not the data.
  if (hasMaster_(state) && JSON.stringify(state.sourceNames) !== JSON.stringify(schema.sourceNames)) {
    state.sourceNames = schema.sourceNames; // only a Source_Column rename: no data change
    saveState_(state);
  }
  if (hasMaster_(state) && JSON.stringify(state.sheetView) !== JSON.stringify(schema.sheetView)) {
    state.sheetView = schema.sheetView;
    state.mirrorDirty = true;
    saveState_(state);
  }

  if (!fullRecompute && !Object.keys(affected).length) {
    if (state.mirrorDirty) writeMasterSheets_(state, false, t0);
    if (stoppedEarly) {
      scheduleContinuation_();
      var wait = 'Files pending — continuing automatically in ~1 minute. ' + scanNotes.join(' | ');
      notify_(wait);
      return wait;
    }
    var idle = 'Master already up to date. ' + scanNotes.join(' | ') +
      (fileErrors ? ' | ' + fileErrors + ' file(s) in ERROR — see PROCESS_LOG.' : '');
    notify_(idle);
    return idle;
  }

  /* ---------- 3. join only the affected keys (or everything) ---------- */
  var datasets = {};
  sources.forEach(function (src) {
    var code = src.Source_Code;
    var kc = sourceKeyCol_(code, src.Unique_Key, cfgCache);
    var dc = resolveOutputColumnName_(code, src.Date_Column, cfgCache);
    var filter = (code === baseName && !fullRecompute) ? affected : null;
    datasets[code] = loadSourceDataset_(state, code, kc, dc, filter, sourceMaxCol_(src, cfgCache));
  });
  var joined = runJoinSteps_(datasets, cfgCache, baseName);

  /* ---------- 4. apply to master ---------- */
  var masterRows = fullRecompute ? new Map() : loadMasterRowsMap_(state);
  var keyIdx = schema.headers.indexOf(keyField);
  var upserts = [];
  var present = {};

  joined.forEach(function (rec) {
    var k = normKey_(rec[keyField]);
    if (!k) return;
    var row = schema.headers.map(function (h) { return cleanOut_(rec[h]); });
    row[keyIdx] = k;
    masterRows.set(k, row);
    present[k] = true;
    upserts.push(row);
  });

  var deletes = [];
  if (!fullRecompute) {
    Object.keys(affected).forEach(function (k) {
      if (!present[k] && masterRows.has(k)) { masterRows.delete(k); deletes.push(k); }
    });
  }

  var version = Date.now();
  if (fullRecompute) {
    clearDeltas_(state);
    state.buildId = Utilities.getUuid();
    state.deltaFloor = version;
  } else {
    appendDelta_(state, upserts, deletes, version);
  }
  writeMasterSnapshot_(state, schema, keyField, Array.from(masterRows.values()), version);
  state.pendingKeys = {};
  state.mirrorDirty = true;
  state.joinDefaultsSig = joinDefaultsSignature_(cfgCache);
  saveState_(state);

  setProcessLogStatuses_(cachedFileIds, 'PROCESSED');

  /* ---------- 5. human-facing sheets (failure here never blocks the dashboard) ---------- */
  var sheetWritten = writeMasterSheets_(state, false, t0);

  var msg = (fullRecompute ? 'Full recompute. ' : 'Incremental. ') +
    'Master rows: ' + state.rowCount + ' · updated: ' + upserts.length + ' · removed: ' + deletes.length +
    ' · files read: ' + cachedFileIds.length +
    (fileErrors ? ' · ' + fileErrors + ' file(s) in ERROR (see PROCESS_LOG)' : '') +
    (stoppedEarly ? ' · more files pending — continuing automatically in ~1 minute' : '') +
    (sheetWritten ? '' : ' · DASHBOARD_MASTER sheet will be written on the next run (dashboard already updated)') +
    ' | ' + scanNotes.join(' | ');
  if (stoppedEarly) scheduleContinuation_();
  notify_(msg);
  return msg;
}


/* ============================== helpers ============================== */

/**
 * A source joined on GR NO changes only its own GRs → incremental is exact.
 * A source joined on anything else (Branch, Lane, Load Type… e.g. a rate card)
 * can change MANY GRs at once, so its change triggers a full recompute of the
 * join — from the caches, no Excel is re-read.
 */
function lookupSourceChanged_(changedSources, baseName, keyField, cfgCache) {
  var steps = getActiveJoinSteps_();
  return Object.keys(changedSources).some(function (code) {
    if (code === baseName) return false;
    return steps.some(function (st) {
      if (String(st.Right_Dataset || '').trim() !== code) return false;
      var lk = resolveDatasetColumn_(String(st.Left_Dataset || '').trim(), st.Left_Key, cfgCache);
      return lk !== keyField;
    });
  });
}

/** Any change here (config or CODE_VERSION) makes that source's files re-read. */
function configSignature_(src, cfg) {
  var basis = JSON.stringify({
    v: SETTINGS.CODE_VERSION,
    dd: SETTINGS.DEFAULT_DECIMALS,
    h: src.Header_Row, d: src.Data_Start_Row, s: src.Sheet_Name_Pattern,
    k: src.Unique_Key, dc: src.Date_Column, rf: src.Row_Filter || '',
    c: cfg.map(function (c) {
      // Ton/Lacs are view-only, so only transformations that change stored values count here
      var t = String(c.Transformation || '').trim().toUpperCase();
      return [c.Source_Column, c.Output_Column, c.Data_Type, unitDivisor_(t) ? '' : t,
              c.Default_Value, decimalsFor_(c)];
    })
  });
  var rf = String(src.Row_Filter || '').trim();
  // only sources that use these options get a new signature (other sources are not re-read)
  if (rf && !/^TBD$/i.test(rf)) basis += '|rf:' + rf;
  if (maxRuleColumn_(src.Duplicate_Rule)) basis += '|dr:' + String(src.Duplicate_Rule).trim();
  return Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, basis));
}

function uniqueOutputColumns_(cfg) {
  var cols = [];
  cfg.forEach(function (c) {
    var o = String(c.Output_Column || '').trim();
    if (o && cols.indexOf(o) === -1) cols.push(o);
  });
  return cols;
}

function cleanOut_(v) {
  if (v === undefined || v === null) return '';
  if (v instanceof Date) return toIsoDate_(v);
  if (typeof v === 'number') return isFinite(v) ? round6_(v) : '';
  return v;
}

function isoToDate_(v) {
  if (typeof v !== 'string') return v;
  var m = v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : v;
}

/**
 * Writes DASHBOARD_MASTER (mirror file and/or local tab) from the master JSON.
 * Runs only when enough of the 6-minute execution budget is left; otherwise
 * it stays "dirty" and the next run (usually idle) writes it.
 * Returns true when the sheets are up to date.
 */
function writeMasterSheets_(state, force, t0) {
  if (!force && !state.mirrorDirty) return true;
  if (!SETTINGS.WRITE_MIRROR_SHEET && !SETTINGS.WRITE_LOCAL_MASTER) return true;

  var elapsed = Date.now() - (t0 || Date.now());
  if (elapsed > 6 * 60 * 1000 - SETTINGS.SHEET_WRITE_MIN_TIME_LEFT_MS) {
    Logger.log('Not enough time left for the DASHBOARD_MASTER sheet write — deferred to next run.');
    return false;
  }

  // Archive.gs: the sheet gets only the recent months (older half-years are in GR_ARCHIVE).
  var sheetRows = readMasterRows_(state);
  if (typeof GRA_mirrorFilter === 'function') sheetRows = GRA_mirrorFilter(state.headers, sheetRows);
  var cells = (sheetRows.length + 1) * Math.max(1, state.headers.length);
  if (cells > SETTINGS.SHEET_MAX_CELLS) {
    Logger.log('DASHBOARD_MASTER sheet skipped: ' + cells + ' cells is over the Google Sheets limit. ' +
               'The dashboard is unaffected (it reads the JSON).');
    state.mirrorDirty = false;
    saveState_(state);
    return true;
  }

  try {
    var data = {
      headers: state.headers,
      dateColumns: state.dateColumns,
      sheetView: state.sheetView || { divisors: {}, formats: {} },
      rows: sheetRows
    };
    if (SETTINGS.WRITE_MIRROR_SHEET) {
      writeTableToSheet_(SpreadsheetApp.openById(MIRROR_FILE_ID), MIRROR_SHEET_NAME, data);
    }
    if (SETTINGS.WRITE_LOCAL_MASTER) {
      writeTableToSheet_(SpreadsheetApp.getActiveSpreadsheet(), SHEET_NAMES.DASHBOARD_MASTER, data);
    }
    state.mirrorDirty = false;
    saveState_(state);
    return true;
  } catch (e) {
    // The dashboard reads the JSON, so it is unaffected. Retried on the next run.
    Logger.log('DASHBOARD_MASTER sheet write failed (will retry next run): ' + e);
    return false;
  }
}

function writeTableToSheet_(ss, sheetName, data) {
  var sheet = ss.getSheetByName(sheetName) || ss.insertSheet(sheetName);
  try { ss.setSpreadsheetTimeZone(Session.getScriptTimeZone()); } catch (e) { /* ignore */ }

  var headers = data.headers || [];
  var rows = data.rows || [];
  var nCols = Math.max(1, headers.length);
  var dateIdx = (data.dateColumns || [])
    .map(function (c) { return headers.indexOf(c); })
    .filter(function (i) { return i >= 0; });

  // Sheet view: Ton / Lacs (from COLUMN_CONFIG Transformation) + Display_Format
  var view = data.sheetView || { divisors: {}, formats: {} };
  var divIdx = [];
  Object.keys(view.divisors || {}).forEach(function (c) {
    var j = headers.indexOf(c);
    if (j >= 0) divIdx.push([j, view.divisors[c]]);
  });

  sheet.clearContents();
  fitGrid_(sheet, rows.length + 1, nCols);
  if (!headers.length) return;

  sheet.getRange(1, 1, 1, nCols).setValues([headers]);
  var chunk = SETTINGS.SHEET_WRITE_CHUNK_ROWS;
  for (var i = 0; i < rows.length; i += chunk) {
    var block = rows.slice(i, i + chunk).map(function (r) {
      var o = r.slice(0, nCols);
      while (o.length < nCols) o.push('');
      dateIdx.forEach(function (j) { o[j] = isoToDate_(o[j]); });
      divIdx.forEach(function (p) { if (typeof o[p[0]] === 'number') o[p[0]] = round6_(o[p[0]] / p[1]); });
      return o;
    });
    sheet.getRange(i + 2, 1, block.length, nCols).setValues(block);
  }
  if (rows.length) {
    dateIdx.forEach(function (j) { sheet.getRange(2, j + 1, rows.length, 1).setNumberFormat('dd-MM-yyyy'); });
    Object.keys(view.formats || {}).forEach(function (c) {
      var j = headers.indexOf(c);
      if (j >= 0) {
        try { sheet.getRange(2, j + 1, rows.length, 1).setNumberFormat(String(view.formats[c])); }
        catch (e) { Logger.log('Bad Display_Format for ' + c + ': ' + view.formats[c]); }
      }
    });
  }
  sheet.setFrozenRows(1);
  SpreadsheetApp.flush();
}

/** Grid = exactly the data + 1 spare row, so empty rows don't eat the cell limit. */
function fitGrid_(sheet, nRows, nCols) {
  var mr = sheet.getMaxRows(), mc = sheet.getMaxColumns();
  if (mr < nRows + 1) sheet.insertRowsAfter(mr, nRows + 1 - mr);
  else if (mr > nRows + 1) sheet.deleteRows(nRows + 2, mr - nRows - 1);
  if (mc < nCols) sheet.insertColumnsAfter(mc, nCols - mc);
  else if (mc > nCols) sheet.deleteColumns(nCols + 1, mc - nCols);
}

function notify_(msg) {
  Logger.log(msg);
  try { SpreadsheetApp.getActiveSpreadsheet().toast(msg, 'GR PNL Engine', 10); } catch (e) { /* no UI */ }
}

function show_(msg) {
  Logger.log(msg);
  try { SpreadsheetApp.getUi().alert(msg); } catch (e) { /* run from editor/trigger */ }
}


/* ============================ admin utilities ============================ */

/**
 * DIAGNOSTIC — opens the newest file of the first source and reports how its
 * date column really arrives (Date object vs text), with samples.
 * Run from the menu, or from the editor and read View → Logs.
 */
function debugDateColumn() {
  ownerOnly_();
  var src = getActiveSources_()[0];
  var cfg = getColumnConfigForSource_(src.Source_Code);
  var dateCfg = cfg.filter(function (c) {
    return String(c.Data_Type || '').trim().toUpperCase() === 'DATE' && String(c.Source_Column || '').trim();
  })[0];
  if (!dateCfg) { show_('No DATE column configured for ' + src.Source_Code); return; }

  var scan = scanSourceFolder_(src, { files: {} }, 'debug');
  if (!scan.pending.length) { show_('No files found in the ' + src.Source_Code + ' folder.'); return; }
  var file = scan.pending[scan.pending.length - 1];

  var opened = openAsSpreadsheet_(file);
  try {
    var raw = readRawRows_(opened.ss, src, cfg);
    var tz = opened.ss.getSpreadsheetTimeZone();
    var col = buildHeaderIndex_(raw.headers)(dateCfg.Source_Column);
    if (col < 0) { show_('Column "' + dateCfg.Source_Column + '" not found in ' + file.fileName); return; }

    var c = { date: 0, text: 0, number: 0, blank: 0 }, maxDay = 0, bigDayText = 0, samples = [];
    raw.rows.forEach(function (r, i) {
      var v = r[col];
      if (v === '' || v === null) { c.blank++; return; }
      if (v instanceof Date) {
        c.date++;
        maxDay = Math.max(maxDay, Number(Utilities.formatDate(v, tz, 'd')));
      } else if (typeof v === 'number') c.number++;
      else {
        c.text++;
        var m = String(v).match(/^(\d{1,2})[-\/.]/);
        if (m && Number(m[1]) > 12) bigDayText++;
      }
      if (samples.length < 12) {
        samples.push('row ' + (i + Number(src.Data_Start_Row || 2)) + ': ' +
          (v instanceof Date ? 'DATE ' + Utilities.formatDate(v, tz, 'dd-MM-yyyy') : typeof v + ' "' + v + '"') +
          '  →  parsed ' + (toIsoDate_(v, tz) || '(invalid)'));
      }
    });

    var verdict;
    if (c.date && bigDayText && maxDay <= 12) {
      verdict = 'Conversion is SWAPPING day/month (day ≤ 12 became a wrong Date, the rest stayed text). ' +
                'DATE_AUTO_SWAP_FIX repairs this automatically.';
    } else if (c.text && !c.date) {
      verdict = 'Dates arrive as TEXT. The new strict dd-mm-yyyy parser handles them (old code lost day > 12).';
    } else if (c.date && !c.text) {
      verdict = 'Dates arrive as real dates — no problem.';
    } else {
      verdict = 'Mixed values — check the samples below.';
    }

    var scriptTz = Session.getScriptTimeZone();
    show_([
      'File: ' + file.fileName,
      'Column: ' + dateCfg.Source_Column,
      'Date objects: ' + c.date + ' | Text: ' + c.text + ' | Numbers: ' + c.number + ' | Blank: ' + c.blank,
      'Max day among Date objects: ' + maxDay + ' | Text with day > 12: ' + bigDayText,
      'Converted-file time zone: ' + tz + ' | Script time zone: ' + scriptTz +
        (scriptTz !== 'Asia/Kolkata' ? '  ⚠ set Project Settings → Time zone = Asia/Kolkata' : ''),
      '',
      'VERDICT: ' + verdict,
      '',
      samples.join('\n')
    ].join('\n'));
  } finally {
    cleanupTempFile_(opened.tempFileId);
  }
}

/**
 * DIAGNOSTIC — lists every file in every source folder (and subfolders) with
 * what the engine will do with it: NEW, CHANGED, already loaded, or SKIPPED + why.
 */
function debugFolders() {
  ownerOnly_();
  ensureAutoRefresh_();
  var state = loadState_();
  var lines = [];
  try {
    var dataId = props_().getProperty(DATA_FOLDER_PROP_);
    lines.push(dataId
      ? '📁 Engine files (dashboard JSON, archive, reports) are in ' + dataFolderName_() + ' — never read as input: ' + DriveApp.getFolderById(dataId).getUrl()
      : '📁 Engine files are not in ' + dataFolderName_() + ' yet: use Dashboard data folder > Move engine files now (or wait for the next refresh).');
    lines.push('');
  } catch (e) { /* show the folders anyway */ }
  getActiveSources_().forEach(function (src) {
    var cfg = getColumnConfigForSource_(src.Source_Code);
    var man = state.sources[src.Source_Code] || { files: {} };
    var folderName;
    try { folderName = DriveApp.getFolderById(String(src.Parent_Folder_ID).trim()).getName(); }
    catch (e) { lines.push(src.Source_Code + ': ❌ cannot open folder ' + src.Parent_Folder_ID + ' — ' + e.message); return; }
    var scan = scanSourceFolder_(src, man, configSignature_(src, cfg));
    lines.push('▶ ' + src.Source_Code + '  (folder: ' + folderName + ')');
    if (!scan.files.length) lines.push('   (no files in this folder or its subfolders)');
    scan.files.slice(0, 40).forEach(function (f) { lines.push('   ' + f.status + '  —  ' + f.path); });
    if (scan.files.length > 40) lines.push('   … ' + (scan.files.length - 40) + ' more (see View → Logs)');
    lines.push('');
  });
  Logger.log(lines.join('\n'));
  show_(lines.join('\n'));
}

/**
 * DIAGNOSTIC — asks for one GR number and shows, for every source, which file(s)
 * contain it and with what values, then the final row in the master.
 * Answers "why is the discount 0 for this GR?" in one look.
 */
function debugGr() {
  ownerOnly_();
  ensureAutoRefresh_();
  var ui = SpreadsheetApp.getUi();
  var r = ui.prompt('Check one GR', 'Enter a GR number:', ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  var gr = normKey_(r.getResponseText());
  if (!gr) return;

  var state = loadState_();
  var sources = getActiveSources_();
  var cfgCache = {};
  sources.forEach(function (s) { cfgCache[s.Source_Code] = getColumnConfigForSource_(s.Source_Code); });
  var lines = ['GR ' + gr, ''];

  sources.forEach(function (src) {
    var code = src.Source_Code;
    var keyCol = resolveOutputColumnName_(code, src.Unique_Key, cfgCache);
    var man = (state.sources[code] || { files: {} }).files;
    var hits = [];
    Object.keys(man).forEach(function (fid) {
      var m = man[fid];
      try {
        var data = readJsonFile_(m.cacheId);
        var k = data.cols.indexOf(keyCol);
        if (k < 0) return;
        data.rows.forEach(function (row) {
          if (normKey_(row[k]) !== gr) return;
          var shown = data.cols.map(function (c, i) { return c + '=' + row[i]; })
            .filter(function (x, i) { return i < 8 || code !== sources[0].Source_Code; });
          hits.push('   ' + m.fileName + ':  ' + shown.join(' · '));
        });
      } catch (e) { hits.push('   ' + m.fileName + ': (cache unreadable — run Full rebuild)'); }
    });
    lines.push('▶ ' + code + ' (key: ' + keyCol + ', ' + Object.keys(man).length + ' file(s) loaded)');
    lines.push(hits.length ? hits.join('\n') : '   ❌ not found in any ' + code + ' file');
    lines.push('');
  });

  if (hasMaster_(state)) {
    var joinedCols = {}; // every column that comes from a joined (right-side) source
    sources.forEach(function (s, si) {
      if (si === 0) return;
      getColumnConfigForSource_(s.Source_Code).forEach(function (c) { joinedCols[String(c.Output_Column).trim()] = true; });
    });
    var k = state.headers.indexOf(state.keyColumn);
    var row = null;
    readMasterRows_(state).some(function (x) { if (String(x[k]) === gr) { row = x; return true; } return false; });
    lines.push('▶ MASTER');
    if (!row) lines.push('   ❌ not in master');
    else {
      var keep = state.headers.map(function (h, i) { return [h, row[i]]; })
        .filter(function (p, i) { return i < 2 || /DIS|DISC/i.test(p[0]) || joinedCols[p[0]]; });
      lines.push('   ' + keep.map(function (p) { return p[0] + '=' + p[1]; }).join(' · '));
    }
  }
  Logger.log(lines.join('\n'));
  show_(lines.join('\n'));
}

function setApiTokenFromMenu() {
  ownerOnly_();
  var ui = SpreadsheetApp.getUi();
  var r = ui.prompt('Set API token',
    'Enter a new long random token (16+ characters). Put the SAME token in the dashboard.',
    ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  var t = r.getResponseText().trim();
  if (t.length < 16) { ui.alert('Use at least 16 characters.'); return; }
  props_().setProperty('API_TOKEN', t);
  ui.alert('Saved. The old token stops working immediately.');
}

/** Kept for older menus / notes. */
function installAutoRefreshTrigger() { return autoRefreshOn(); }


/* ---------------------------------------------------------------------------
 * Source-level options for lookup files such as CARDRATE
 *   Unique_Key  one column (GRNO) or several joined with "+"
 *               (ORIGIN+DESTINATION+VIA_BORDER). Blank parts are allowed.
 *   Row_Filter  keep only matching rows, e.g.  RATECATEGORY=W; GOODS=
 *               "=" equals (blank = empty), "<>" not equal, "|" = any of.
 * ------------------------------------------------------------------------- */
var COMPOSITE_KEY_ = '__KEY__';

function keyParts_(spec) {
  return String(spec || '').split('+').map(function (s) { return s.trim(); }).filter(function (s) { return s; });
}

function sourceKeyCol_(code, spec, cfgCache) {
  var parts = keyParts_(spec);
  if (parts.length <= 1) return resolveOutputColumnName_(code, spec, cfgCache);
  return COMPOSITE_KEY_;
}

function addCompositeKey_(recs, code, spec, cfgCache) {
  var parts = keyParts_(spec);
  if (parts.length <= 1) return;
  var cols = parts.map(function (p) { return resolveOutputColumnName_(code, p, cfgCache); });
  recs.forEach(function (r) {
    var vals = cols.map(function (c) { return normKey_(r[c]).toUpperCase().replace(/\s+/g, ' '); });
    r[COMPOSITE_KEY_] = vals.join('') ? vals.join('|') : '';
  });
}

function applyRowFilter_(recs, src, cfgCache) {
  var spec = String(src.Row_Filter || '').trim();
  if (!spec || /^TBD$/i.test(spec)) return { records: recs, dropped: 0 };
  var rules = spec.split(';').map(function (s) { return s.trim(); }).filter(function (s) { return s; }).map(function (s) {
    var m = s.match(/^(.+?)\s*(<>|!=|=)\s*(.*)$/);
    if (!m) throw new Error('SOURCE_CONFIG Row_Filter for ' + src.Source_Code + ': cannot read "' + s + '"');
    return {
      col: resolveOutputColumnName_(src.Source_Code, m[1].trim(), cfgCache),
      neg: m[2] !== '=',
      vals: m[3].split('|').map(function (v) { return v.trim().toUpperCase(); })
    };
  });
  var out = recs.filter(function (r) {
    return rules.every(function (ru) {
      var v = r[ru.col]; v = (v === null || v === undefined) ? '' : String(v).trim().toUpperCase();
      var hit = ru.vals.indexOf(v) >= 0;
      return ru.neg ? !hit : hit;
    });
  });
  return { records: out, dropped: recs.length - out.length };
}

/** SOURCE_CONFIG Duplicate_Rule = MAX:<column> → keep the row with the highest value of that column. */
function sourceMaxCol_(src, cfgCache) {
  var c = maxRuleColumn_(src.Duplicate_Rule);
  return c ? resolveOutputColumnName_(src.Source_Code, c, cfgCache) : null;
}

/**
 * DIAGNOSTIC — runs the JOIN_CONFIG steps on the cached data (nothing is written)
 * and shows, per step, the key columns used and how many GRs found a match.
 */
function debugJoin() {
  ownerOnly_();
  var state = loadState_();
  var sources = getActiveSources_();
  var cfgCache = {};
  sources.forEach(function (s) { cfgCache[s.Source_Code] = getColumnConfigForSource_(s.Source_Code); });
  var datasets = {};
  sources.forEach(function (src) {
    var code = src.Source_Code;
    datasets[code] = loadSourceDataset_(state, code, sourceKeyCol_(code, src.Unique_Key, cfgCache),
      resolveOutputColumnName_(code, src.Date_Column, cfgCache), null, sourceMaxCol_(src, cfgCache));
  });
  JOIN_STATS_ = [];
  try { runJoinSteps_(datasets, cfgCache, getBaseDatasetName_(sources)); }
  catch (e) { JOIN_STATS_.push({ error: String(e && e.message || e) }); }
  var lines = [];
  Object.keys(datasets).forEach(function (k) { lines.push(k + ': ' + datasets[k].length + ' rows in cache'); });
  lines.push('');
  JOIN_STATS_.forEach(function (s) {
    if (s.error) { lines.push('ERROR: ' + s.error); return; }
    lines.push('Step ' + s.step + ': ' + s.L + ' + ' + s.R);
    lines.push('   left key  = ' + s.lk.join(' + ') + '   |   right key = ' + s.rk.join(' + '));
    lines.push('   left rows ' + s.left + ', right rows ' + s.right + ' (' + s.rightKeys + ' unique keys)');
    lines.push('   MATCHED ' + s.matched + ' | not matched ' + (s.left - s.matched - s.filteredOut - s.blankKey) +
               ' | blank key ' + s.blankKey + ' | skipped by Left_Filter ' + s.filteredOut);
    lines.push('   sample left keys:  ' + s.sampleL.join('  ·  '));
    lines.push('   sample right keys: ' + s.sampleR.join('  ·  '));
    lines.push('');
  });
  JOIN_STATS_ = null;
  Logger.log(lines.join('\n'));
  show_(lines.join('\n'));
}

/** Rebuilds DASHBOARD_MASTER from the cached files with the current JOIN_CONFIG and engine code.
 *  Use after replacing engine files: no Excel file is read again. */
function rebuildMasterFromCache() {
  ownerOnly_();
  ensureAutoRefresh_();
  return withLock_(function () {
    var s = loadState_();
    s.joinDefaultsSig = 'force-rebuild-' + Date.now();   // makes the next build a full recompute
    saveState_(s);
    return runIncrementalRefresh_();
  });
}