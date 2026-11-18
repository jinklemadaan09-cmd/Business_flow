/**
 * WEBAPP.GS
 * ---------
 * ONE Web App URL does two jobs:
 *
 *  1. DASHBOARD LINK  — open the URL with no parameters → the dashboard page
 *     (HTML file "Dashboard" in this project). Share this link with the team.
 *     The page gets its data through google.script.run → liveApi(), so no
 *     token is needed in the page. Who can open it = the deployment's
 *     "Who has access" setting.
 *
 *  2. JSON API (for a dashboard opened as a local file) — needs ?token=...
 *       ?token=T                      full-load header
 *       ?token=T&part=N&build=B       rows of part N (gzip)
 *       ?token=T&since=V&build=B      only changes (gzip)
 *       ?token=T&mode=meta            versions / row count only
 *       ?token=T&mode=card            card rate list (source whose code contains CARD)
 *     Add &plain=1 for plain JSON (debugging).
 *
 * Deploy: Deploy → New deployment → Web app, Execute as: Me.
 * After any code change: Deploy → Manage deployments → Edit → Version: New version.
 */

function doGet(e) {
  var p = (e && e.parameter) || {};
  if (p.fn !== undefined) return pageCall_(String(p.fn), p.a, false);   // hosted website (GET, faster than POST)
  var isApiCall = p.token !== undefined || p.part !== undefined || p.since !== undefined || p.mode !== undefined;
  if (!isApiCall) return serveDashboard_();

  try {
    var token = props_().getProperty('API_TOKEN');
    if (!token) return textOut_(JSON.stringify({ ok: false, error: 'API token not configured — menu: GR PNL Engine → Set API token.' }));
    if (String(p.token || '') !== token) return textOut_(JSON.stringify({ ok: false, error: 'Unauthorized' }));
    return textOut_(apiCore_(p));
  } catch (err) {
    return textOut_(JSON.stringify({ ok: false, error: String(err && err.message || err) }));
  }
}

/** The shared dashboard page. */
function serveDashboard_() {
  try {
    return HtmlService.createHtmlOutputFromFile('Dashboard')
      .setTitle('GR P&L Dashboard')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1');
  } catch (err) {
    return HtmlService.createHtmlOutput(
      '<p style="font-family:sans-serif">Dashboard file not found. In the Apps Script editor add an ' +
      'HTML file named <b>Dashboard</b> and paste the dashboard HTML into it, then deploy a new version.</p>');
  }
}

/**
 * Called by the shared dashboard page (google.script.run.liveApi).
 * Access is controlled by the deployment, so no token here.
 * Returns a JSON string (same shapes as the token API).
 */
function liveApi(params) {
  try {
    params = params || {};
    if (SETTINGS.REQUIRE_LOGIN) {
      if (!checkSession_(params.session)) return JSON.stringify({ ok: false, error: 'LOGIN_REQUIRED' });
    }
    delete params.session;
    return apiCore_(params);
  } catch (err) {
    return JSON.stringify({ ok: false, error: String(err && err.message || err) });
  }
}

/** Builds the API response text for full / part / delta / meta requests. */
function apiCore_(p) {
  var state = p.mode === 'card' ? loadState_() : loadApiState_();
  if (!hasMaster_(state)) return JSON.stringify({ ok: false, error: 'No data yet — run Refresh or Full rebuild once.' });

  var build = String(p.build || '');
  var plain = String(p.plain || '') === '1';

  if (p.mode === 'card') return cardApi_(state, plain);

  /* view=recent (website): only the parts without the months that are in Cloudflare R2 (R2.gs, Cache.gs) */
  var recent = String(p.view || '') === 'recent' && state.recentParts && state.recentParts.length &&
               state.recentInfo && state.recentInfo.version === state.version;
  var partIds = recent ? state.recentParts : state.masterParts;

  if (p.part !== undefined && p.part !== '') {
    var n = Number(p.part);
    if (build !== state.buildId) return JSON.stringify({ ok: false, error: 'STALE_BUILD', buildId: state.buildId });
    if (!(n >= 0 && n < partIds.length)) return JSON.stringify({ ok: false, error: 'Bad part number' });
    if (plain) return readTextFile_(partIds[n]);
    var bytes = readFileBytes_(partIds[n]);
    if (p.sliceSize && isGzipBytes_(bytes)) {   // hosted website: big parts travel in slices (large web-app responses fail)
      var b64 = Utilities.base64Encode(bytes), size = Math.max(100000, Number(p.sliceSize) || 900000),
          cnt = Math.ceil(b64.length / size), i = Math.min(cnt - 1, Math.max(0, Number(p.slice) || 0));
      return JSON.stringify({ ok: true, enc: 'gzip-b64-slices', n: cnt, i: i, data: b64.substr(i * size, size) });
    }
    return packed_(bytes); // stored gzip bytes, sent as they are
  }

  var since = Number(p.since || 0);
  if (p.mode !== 'meta' && since > 0 && build === state.buildId && since >= state.deltaFloor) {
    /* After a refresh every open dashboard asks for the same changes. The answer only depends on
       (build, since, version), so it is built once and kept in the script cache for 10 minutes,
       instead of every user reading the delta files from Drive again. */
    var dCache = CacheService.getScriptCache();
    var dKey = 'dlt_' + String(state.buildId).slice(0, 12) + '_' + since + '_' + state.version + (plain ? '_p' : '');
    try { var dHit = dCache.get(dKey); if (dHit) return dHit; } catch (e) { /* ignore */ }
    var delta = buildDeltaResponse_(state, since), dOut;
    if (plain || (!delta.upserts.length && !delta.deletes.length)) dOut = JSON.stringify(delta);
    else dOut = packed_(Utilities.gzip(Utilities.newBlob(JSON.stringify(delta), 'application/json')).getBytes());
    try { if (dOut.length < 95000) dCache.put(dKey, dOut, 600); } catch (e) { /* too big: just not cached */ }
    return dOut;
  }

  return JSON.stringify({
    ok: true,
    mode: p.mode === 'meta' ? 'meta' : 'full',
    buildId: state.buildId,
    version: state.version,
    generatedAt: new Date(state.version).toISOString(),
    headers: state.headers,
    keyColumn: state.keyColumn,
    dateColumns: state.dateColumns,
    sourceNames: state.sourceNames || [],
    rowCount: state.rowCount,
    parts: partIds.length,
    view: recent ? 'recent' : 'full',
    recentFrom: recent ? state.recentInfo.from : '',
    r2Halves: recent ? state.recentInfo.halves : []
  });
}

/** Merges every delta newer than `since` (later deltas win per key). */
function buildDeltaResponse_(state, since) {
  var keyIdx = state.headers.indexOf(state.keyColumn);
  var merged = new Map();

  state.deltas
    .filter(function (d) { return d.version > since; })
    .sort(function (a, b) { return a.version - b.version; })
    .forEach(function (d) {
      var data = readJsonFile_(d.id);
      data.upserts.forEach(function (r) { merged.set(String(r[keyIdx]), r); });
      data.deletes.forEach(function (k) { merged.set(String(k), null); });
    });

  var upserts = [], deletes = [];
  merged.forEach(function (row, key) {
    if (row) upserts.push(row); else deletes.push(key);
  });

  return {
    ok: true,
    mode: 'delta',
    buildId: state.buildId,
    version: Math.max(state.version, since),
    headers: state.headers,
    keyColumn: state.keyColumn,
    dateColumns: state.dateColumns,
    sourceNames: state.sourceNames || [],
    upserts: upserts,
    deletes: deletes
  };
}

/** gzip bytes → '{ ok, enc:"gzip-b64", data }' (plain JSON bytes are returned as text). */
function packed_(bytes) {
  if (!isGzipBytes_(bytes)) return Utilities.newBlob(bytes).getDataAsString('UTF-8');
  return JSON.stringify({ ok: true, enc: 'gzip-b64', data: Utilities.base64Encode(bytes) });
}

function textOut_(text) {
  return ContentService.createTextOutput(text).setMimeType(ContentService.MimeType.JSON);
}

/** Card rate list for the Discount Advisor page: every row of the card rate source
 *  (Source_Code containing "CARD"), with its Output_Column names. */
function cardApi_(state, plain) {
  var codes = Object.keys(state.sources || {}).filter(function (c) { return /CARD/i.test(c); });
  var cols = [], rows = [];
  if (codes.length) {
    var man = state.sources[codes[0]];
    Object.keys(man.files)
      .map(function (id) { return man.files[id]; })
      .sort(function (a, b) { return a.lastUpdated - b.lastUpdated; })
      .forEach(function (m) {
        var data = readJsonFile_(m.cacheId);
        var at = data.cols.map(function (c) {
          var i = cols.indexOf(c);
          if (i < 0) { cols.push(c); i = cols.length - 1; }
          return i;
        });
        data.rows.forEach(function (r) {
          var o = [];
          for (var i = 0; i < r.length; i++) o[at[i]] = r[i];
          rows.push(o);
        });
      });
  }
  var out = JSON.stringify({ ok: true, mode: 'card', source: codes[0] || '', cols: cols, rows: rows });
  if (plain) return out;
  return packed_(Utilities.gzip(Utilities.newBlob(out, 'application/json')).getBytes());
}

/**
 * Same calls as google.script.run, for the dashboard opened from its own website
 * (Cloudflare Pages). Body (text/plain): {"fn":"liveApi","args":[...]}.
 * Only the functions the page needs are allowed; data calls still need a valid sign-in session.
 */
var PAGE_FUNCTIONS_ = { liveApi: true, authLogin: true, authCheck: true, authLogout: true, apiTimings: true, lanesGet: true, lanesSave: true, ngGet: true, ngSave: true, layoutGet: true, layoutSave: true, reportsList: true, reportGet: true, reportUpload: true, reportDelete: true };
function doPost(e) {
  var req = {};
  try { req = JSON.parse((e && e.postData && e.postData.contents) || '{}'); } catch (x) { /* bad body */ }
  return pageCall_(String(req.fn || ''), req.args, true);
}
var PAGE_POST_ONLY_ = { authLogin: true, lanesSave: true, ngSave: true, layoutSave: true, reportUpload: true };   // passwords and uploads never travel in a URL
function pageCall_(fn, args, isPost) {
  var out;
  try {
    if (!PAGE_FUNCTIONS_[fn]) throw new Error('Not allowed: ' + fn);
    if (PAGE_POST_ONLY_[fn] && !isPost) throw new Error('Use POST for ' + fn);
    if (typeof args === 'string') args = JSON.parse(args || '[]');
    if (!Array.isArray(args)) args = [];
    out = { v: this[fn].apply(null, args) };
  } catch (err) {
    out = { __err: String(err && err.message || err) };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

/** Timing check for the website (needs a valid session). */
function apiTimings(session) {
  var t = Date.now(), out = {};
  var ok = !!checkSession_(session); out.session = Date.now() - t; if (!ok) return { ok: false };
  t = Date.now(); var hit = !!CacheService.getScriptCache().get(API_STATE_KEY_); var st = loadApiState_(); out.state = Date.now() - t; out.stateCached = hit;
  t = Date.now(); var b = readFileBytes_(st.masterParts[0]); out.readPart = Date.now() - t; out.partBytes = b.length;
  t = Date.now(); var s = Utilities.base64Encode(b); out.base64 = Date.now() - t; out.b64Len = s.length;
  t = Date.now(); JSON.stringify({ v: JSON.stringify({ data: s.substr(0, 900000) }) }); out.stringify = Date.now() - t;
  try { out.stateSize = JSON.stringify(st).length; } catch (e) {}
  return { ok: true, t: out };
}
