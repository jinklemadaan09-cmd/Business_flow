/**
 * DATAFOLDERS.GS
 * --------------
 * One home for everything the engine writes to Drive, kept apart from the input (P&L / DSR) folders:
 *
 *   GR_DASHBOARD_DATA/                 made next to the engine spreadsheet (or in My Drive when
 *     GR_PNL_ENGINE_CACHE/             the spreadsheet itself sits inside an input folder)
 *       engine_state.json, dashboard_master_part_N.json, delta_*.json, cache_*.json
 *     GR_ARCHIVE/  (+ old/)            half-year archive sheets and their gzip JSON copies
 *     GR_PNL_REPORTS/                  decks / files users download from the dashboard
 *     READ_ME - do not delete.txt
 *
 * Every folder is found by its Drive id (script properties / ARCHIVE_SETTINGS), and moving a folder
 * in Drive keeps its id, so moving the existing folders in here changes nothing for the dashboard.
 * The input scanner (filereader.gs) never walks into these folders.
 * If one of them is put in the Trash by mistake, the engine takes it back out on its next run.
 */

var DATA_FOLDER_PROP_ = 'DASHBOARD_DATA_FOLDER_ID';
var DATA_LAYOUT_PROP_ = 'DASHBOARD_DATA_LAYOUT';
var DATA_LAYOUT_VERSION_ = 'v1';

function dataFolderName_() { return SETTINGS.DATA_FOLDER_NAME || 'GR_DASHBOARD_DATA'; }

/** Folder names the input scanner always skips, even before their ids are known. */
function engineFolderNames_() {
  var n = {};
  [dataFolderName_(), SETTINGS.CACHE_FOLDER_NAME || 'GR_PNL_ENGINE_CACHE',
   SETTINGS.REPORTS_FOLDER_NAME || 'GR_PNL_REPORTS', 'GR_ARCHIVE'].forEach(function (x) { n[x] = true; });
  return n;
}

/** Ids of the engine folders that exist already (nothing is created here). */
function engineFolderIds_() {
  var ids = {}, p = props_();
  [DATA_FOLDER_PROP_, PROP_CACHE_FOLDER, PROP_REPORTS_FOLDER_].forEach(function (k) {
    var v = p.getProperty(k);
    if (v) ids[v] = true;
  });
  try {
    var a = GRA_idFrom_(GRA_settings_(GRA_engineSs_()).ARCHIVE_FOLDER_ID);
    if (a) ids[a] = true;
  } catch (e) { /* no archive settings yet */ }
  return ids;
}

/** Folder by id; un-trashes it when it was put in the Trash. null when it is gone for good. */
function folderByIdRestore_(id, label) {
  if (!id) return null;
  var f;
  try { f = DriveApp.getFolderById(id); } catch (e) { return null; }
  try {
    if (f.isTrashed()) {
      f.setTrashed(false);
      Logger.log('Restored the ' + label + ' folder "' + f.getName() + '" from the Drive Trash.');
    }
  } catch (e) { Logger.log('Could not restore ' + label + ' folder from Trash: ' + e.message); return null; }
  return f;
}

/** GR_DASHBOARD_DATA: found by id, else by name next to the engine sheet, else created there. */
function getDataFolder_() {
  var p = props_();
  var f = folderByIdRestore_(p.getProperty(DATA_FOLDER_PROP_), 'dashboard data');
  if (f) return f;

  var base = dataFolderBase_(), name = dataFolderName_(), it = base.getFoldersByName(name);
  while (it.hasNext()) { var c = it.next(); if (!c.isTrashed()) { f = c; break; } }
  if (!f) {
    f = base.createFolder(name);
    try {
      f.setDescription('Made by the GR PNL Engine. The dashboard reads these files. Do not delete, rename or move files out of here.');
      f.createFile('READ_ME - do not delete.txt',
        'This folder is made and used by the GR PNL Engine.\n\n' +
        'GR_PNL_ENGINE_CACHE  data the dashboard loads (JSON files)\n' +
        'GR_ARCHIVE           half-year archive of old months\n' +
        'GR_PNL_REPORTS       files users download from the dashboard\n\n' +
        'Do not delete, rename or move anything out of here. Put P&L / DSR input files in their own folders, not here.\n' +
        'If this folder is deleted by mistake, take it out of the Drive Trash (the engine also does this itself on its next run).\n');
    } catch (e) { /* the note is optional */ }
  }
  p.setProperty(DATA_FOLDER_PROP_, f.getId());
  return f;
}

/** Next to the engine spreadsheet, unless that folder is (inside) an input folder: then My Drive. */
function dataFolderBase_() {
  var root = DriveApp.getRootFolder(), base = root;
  try {
    var parents = DriveApp.getFileById(GRA_engineSs_().getId()).getParents();
    if (parents.hasNext()) base = parents.next();
  } catch (e) { return root; }
  return isInsideInputFolder_(base) ? root : base;
}

function inputFolderIds_() {
  var ids = {};
  try {
    getActiveSources_().forEach(function (s) {
      var id = String(s.Parent_Folder_ID || '').trim();
      if (id) ids[id] = true;
    });
  } catch (e) { /* no SOURCE_CONFIG yet */ }
  return ids;
}

function isInsideInputFolder_(folder) {
  var inputs = inputFolderIds_(), f = folder;
  for (var depth = 0; f && depth < 25; depth++) {
    if (inputs[f.getId()]) return true;
    var up = f.getParents();
    f = up.hasNext() ? up.next() : null;
  }
  return false;
}

/** True when folder is already directly in parent. */
function isChildOf_(folder, parent) {
  var it = folder.getParents();
  while (it.hasNext()) if (it.next().getId() === parent.getId()) return true;
  return false;
}

/**
 * One-time move of the existing engine folders into GR_DASHBOARD_DATA. Ids do not change, so the
 * dashboard and the 2-hourly refresh keep reading the same files. Runs at the start of a refresh
 * until it has worked once; returns text lines for the menu.
 */
function ensureDataFolderLayout_(force) {
  var p = props_();
  if (!force && p.getProperty(DATA_LAYOUT_PROP_) === DATA_LAYOUT_VERSION_) return [];
  var lines = [], ok = true, data;
  try { data = getDataFolder_(); }
  catch (e) { Logger.log('Dashboard data folder: ' + e.message); return ['❌ cannot make ' + dataFolderName_() + ': ' + e.message]; }

  var archiveId = '';
  try { archiveId = GRA_idFrom_(GRA_settings_(GRA_engineSs_()).ARCHIVE_FOLDER_ID); } catch (e) { /* none yet */ }

  [
    { label: 'engine cache (JSON)', id: p.getProperty(PROP_CACHE_FOLDER) },
    { label: 'reports', id: p.getProperty(PROP_REPORTS_FOLDER_) },
    { label: 'archive', id: archiveId }
  ].forEach(function (x) {
    if (!x.id) { lines.push('• ' + x.label + ': not made yet, it will be made inside ' + data.getName()); return; }
    var f = folderByIdRestore_(x.id, x.label);
    if (!f) { lines.push('• ' + x.label + ': folder not found, a new one will be made inside ' + data.getName()); return; }
    if (f.getId() === data.getId() || isChildOf_(f, data)) { lines.push('• ' + x.label + ': already in ' + data.getName()); return; }
    try {
      f.moveTo(data);
      lines.push('✓ ' + x.label + ': "' + f.getName() + '" moved into ' + data.getName());
    } catch (e) {
      ok = false;
      lines.push('❌ ' + x.label + ': could not move "' + f.getName() + '" (' + e.message + '). It keeps working where it is.');
    }
  });

  if (ok) p.setProperty(DATA_LAYOUT_PROP_, DATA_LAYOUT_VERSION_);
  Logger.log('Dashboard data folder:\n' + lines.join('\n'));
  return lines;
}

/** Menu: move the engine folders now and show where they are. */
function setupDashboardDataFolder() {
  ownerOnly_();
  var lines = ensureDataFolderLayout_(true), data = getDataFolder_();
  dataFolderDialog_('Dashboard data folder',
    'All engine files (dashboard JSON, archive, reports) are in "' + data.getName() + '". ' +
    'Input folders are not touched and the engine never reads this folder as input.\n\n' + lines.join('\n'),
    data.getUrl());
}

/** Menu: link to the folder. */
function openDashboardDataFolder() {
  ownerOnly_();
  var data = getDataFolder_();
  dataFolderDialog_('Dashboard data folder',
    'Folder "' + data.getName() + '". Do not delete or move files out of it.', data.getUrl());
}

function dataFolderDialog_(title, text, url) {
  Logger.log(title + ': ' + text + (url ? '\n' + url : ''));
  try {
    var html = '<div style="font:13px Arial;white-space:pre-wrap">' + GRA_esc_(text) + '</div>' +
      (url ? '<p style="font:13px Arial"><a href="' + url + '" target="_blank">Open the folder</a></p>' : '');
    SpreadsheetApp.getUi().showModalDialog(HtmlService.createHtmlOutput(html).setWidth(520).setHeight(300), title);
  } catch (e) { /* run from editor/trigger */ }
}
