/**
 * CONCISEDANALYSIS.GS
 * -------------------
 * Project: Concised Analysis.
 * Writes a short sales review into the "Sales Tracker" Google Sheet from the same master data
 * the dashboard reads (engine JSON). Nothing on the sheet is typed by hand except the targets.
 *
 *   Tab "Concised Analysis"   five blocks, rebuilt on every run
 *     1. Where we stand (month to date), zone-wise
 *     2. Last week: goal vs achievement, zone-wise
 *     3. This week: goals, zone-wise
 *     4. Action tracker points
 *     5. Action plan: where to work
 *     6. The numbers (weekly meeting bullets: revenue vs target, FTL/LTL, run rate, best day,
 *        stuck and working zones with circles, LTL yield vs benchmark)
 *     7. Last week's goals & achievements and this week's goals (bullets)
 *     8. Zone gap: GAP, daily asking rate, coming week goal (Rs Cr). By Whom / By When are typed
 *        by hand and kept on every rebuild.
 *   Tab "Targets"             monthly revenue target and GP % target per zone (the only inputs)
 *
 * Revenue = TOTAL FREIGHT. GP = TOTAL FREIGHT - TOTAL EXPENSE. Zone = BOOKING ZONE.
 * Weeks run Monday to Sunday. Amounts are shown in Rs Lacs.
 *
 * Runs every hour (menu: GR PNL Engine > Concised Analysis > Turn on hourly update).
 * A run is skipped when the engine data and the date have not changed since the last write.
 * The account that owns the engine needs Editor access to the Sales Tracker sheet.
 */

var CA_ = {
  SPREADSHEET_ID: '1lepclQ-5RtsCYIBtl3IcC5E48HNsuY_fQb-zMazbM1U',   // Sales Tracker
  SHEET: 'Concised Analysis',
  TARGETS_SHEET: 'Targets',
  TZ: 'Asia/Kolkata',

  // Starting monthly revenue targets (Rs Lacs), written into the Targets tab when a zone has no row yet.
  // Source: PAN INDIA - Final Target 26-27.xlsx, tab "NOV`26 Target", column "Target Nov`26"
  // (West 412 and Gujarat West 545 as in the row totals of that tab and its copy).
  // Zone names match with or without a trailing " RO". Change the Targets tab, not this list.
  MANUAL_SEED_SHEET: 'Next Week Goal',   // By Whom / By When are copied from here the first time
  SEED_TARGETS_LACS: {
    'TOTAL': 2750, 'NORTH ZONE': 1072, 'SOUTH ZONE': 435, 'WEST ZONE': 412, 'GUJARAT WEST ZONE': 545,
    'EAST ZONE': 163, 'NORTH EAST ZONE': 92, 'NEPAL ZONE': 31
  },
  // A blank GP % target means: hold the zone's own GP % of the last 3 full months.

  ACHIEVED_PCT: 1.00,     // % achievement at or above this = Achieved
  CLOSE_PCT: 0.90,        // at or above this = Close, below = Missed
  LOW_GP_PCT: 0.10,       // customers under this GP % are listed in the action plan
  MIN_CUSTOMER_LACS: 2,   // ignore customers below this revenue (Rs Lacs) in a 4-week window
  ACTION_POINTS: 8,
  ACTION_PLAN_ROWS: 15,
  PLAN_CONSIGNORS: 4,     // consignor names listed against each branch in the action plan
  LOST_MIN_LACS: 1,       // lost customer: at least this much last month, nothing this month
  LOST_ROWS: 30,
  NEG_GP_ROWS: 30,

  // Copies sent to other sheets after each update. A blank id switches that copy off.
  // The engine owner needs Editor access to each of these files.
  PUSH: {
    HUDDLE_ID: '1TvdMNI9H39gNceZhOFZbI_MgEHHK6cVZwRhk0LbF9ow',   // Sales Weekly/ Daily Tracker Sugam 2026
    HUDDLE_SHEET: '',                                             // blank = first tab
    HUDDLE_ROWS: [                                                // agenda row (text match) -> text written in its notes cell
      { match: 'THE NUMBERS', text: 'month' },
      { match: 'GOALS', text: 'week' }
    ],
    HUDDLE_NOTES_HEAD: ['NOTES', 'NOTE', 'REMARKS', 'DETAILS', 'DISCUSSION'],
    WEEKLY_ID: '1ffENUOTaLgQxVlxVqkfKzOr3-kCDVFqQaLX1mdXvPXM',    // last week / this week sheet
    WEEKLY_SHEET: 'Sales Tracker - Weekly',
    WEEKLY_BLOCKS: ['2.', '3.'],
    ACTION_ID: '1akcGiG2Fk6XsIlUCMfTVzUK7DvKiGGP01s4_88OgY_w',    // action tracker sheet
    ACTION_SHEET: 'Sales Tracker - Actions',
    ACTION_BLOCKS: ['4.', '5.', '9.', '10.']
  },

  PROP_LAST: 'CA_LAST_RUN_V3'   // new name after a layout change, so the next hourly run rebuilds
};

var CA_COLORS_ = {
  title: '#1F2937', sub: '#6B7280', head: '#1F3864', headText: '#FFFFFF',
  block: '#1F3864', line: '#D9DEE7', total: '#EEF1F6',
  good: '#1E7B34', warn: '#A86400', bad: '#B42318'
};


/* ================================ menu + triggers ================================ */

function CA_menu_(ui) {
  return ui.createMenu('Concised Analysis')
    .addItem('Update now', 'concisedAnalysisUpdate')
    .addItem('Turn on hourly update', 'concisedAnalysisOn')
    .addItem('Turn off hourly update', 'concisedAnalysisOff');
}

function concisedAnalysisOn() {
  removeTriggers_('concisedAnalysisScheduled');
  ScriptApp.newTrigger('concisedAnalysisScheduled').timeBased().everyHours(1).create();
  concisedAnalysisUpdate();
}

function concisedAnalysisOff() {
  removeTriggers_('concisedAnalysisScheduled');
  try { SpreadsheetApp.getActiveSpreadsheet().toast('Concised Analysis: hourly update is off.'); } catch (e) { /* no UI */ }
}

/** Hourly: only rebuilds when the master data or the day changed. */
function concisedAnalysisScheduled() { return CA_run_(false); }

/** Menu: always rebuilds. */
function concisedAnalysisUpdate() {
  var msg = CA_run_(true);
  try { SpreadsheetApp.getActiveSpreadsheet().toast(msg, 'Concised Analysis', 8); } catch (e) { /* no UI */ }
  return msg;
}

function CA_run_(force) {
  var state = loadState_();
  if (!hasMaster_(state)) return 'No master data yet.';
  var today = Utilities.formatDate(new Date(), CA_.TZ, 'yyyy-MM-dd');
  var key = state.version + '|' + today;
  var props = PropertiesService.getScriptProperties();
  if (!force && props.getProperty(CA_.PROP_LAST) === key) return 'No change since the last update.';

  var ss = SpreadsheetApp.openById(CA_.SPREADSHEET_ID);
  var targets = CA_readTargets_(ss);
  var rows = CA_readRows_(state, CA_firstDayNeeded_(today));
  var model = CA_build_(rows, targets, today);
  var tz = {};
  model.zones.forEach(function (z) { tz[CA_zk_(z)] = model.targets[z].month; });
  model.meeting = CA_meeting_(rows, { zones: tz, total: model.targetTotal.month }, CA_cut_(model.dataTo, today));
  CA_writeTargets_(ss, model);
  var stamp = Utilities.formatDate(new Date(), CA_.TZ, 'dd-MMM-yy HH:mm');
  CA_render_(ss, model, stamp);
  SpreadsheetApp.flush();
  var notes = CA_push_(ss.getSheetByName(CA_.SHEET), model, stamp);
  props.setProperty(CA_.PROP_LAST, key);
  return 'Updated: data up to ' + CA_fmtDay_(model.dataTo) + '.' + (notes.length ? '\n' + notes.join('\n') : '');
}


/* ================================ data in ================================ */

/** Earliest date any block needs: first day of the 3rd full month back (circle shares, yield benchmark), or 6 weeks back. */
function CA_firstDayNeeded_(today) {
  var t = CA_d_(today);
  var a = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() - 3, 1));
  var b = CA_addDays_(t, -42);
  return CA_iso_(a < b ? a : b);
}

/** Master rows from the engine JSON → slim records (raw Rs and kg). */
function CA_readRows_(state, fromDay) {
  var h = state.headers;
  var col = function (names) {
    for (var i = 0; i < names.length; i++) {
      var k = h.map(normName_).indexOf(normName_(names[i]));
      if (k >= 0) return k;
    }
    return -1;
  };
  var ix = {
    date: col(['GR DT', 'GR DATE']), zone: col(['BOOKING ZONE', 'ORIGIN ZONE']),
    branch: col(['BOOKING BRANCH', 'ORIGIN']), cust: col(['CONSIGNOR', 'CNGR']),
    rev: col(['TOTAL FREIGHT']), exp: col(['TOTAL EXPENSE', 'TOTAL EXPENSES']),
    circle: col(['BOOKING CIRCLE', 'ORIGIN CIRCLE']), lt: col(['LOAD TYPE']),
    cw: col(['CWEIGHT', 'CHARGED WEIGHT']), fr: col(['BASIC FREIGHT', 'FREIGHT'])
  };
  var at = function (r, i) { return i >= 0 ? r[i] : ''; };
  var out = [];
  (state.masterParts || []).forEach(function (id) {
    var part = readJsonFile_(id);
    part.rows.forEach(function (r) {
      var d = r[ix.date];
      if (typeof d !== 'string' || d < fromDay) return;
      out.push(CA_rec_(d, r[ix.zone], r[ix.branch], r[ix.cust], r[ix.rev], at(r, ix.exp),
                       at(r, ix.circle), at(r, ix.lt), at(r, ix.cw), at(r, ix.fr)));
    });
  });
  return out;
}

function CA_rec_(day, zone, branch, cust, rev, exp, circle, loadType, cweight, basic) {
  var s = function (v) { v = String(v == null ? '' : v).replace(/\s+/g, ' ').trim(); return v || 'UNSPECIFIED'; };
  var n = function (v) { v = Number(v); return isFinite(v) ? v : 0; };
  var lt = s(loadType).toUpperCase();
  return { d: day.slice(0, 10), z: s(zone), b: s(branch), c: s(cust), rev: n(rev), gp: n(rev) - n(exp),
           ci: s(circle), lt: lt === 'SML' ? 'LTL' : lt, cw: n(cweight), fr: n(basic) };
}

/** Last full day with data: the data's last day, but never today (today is still being booked). */
function CA_cut_(dataTo, today) {
  return dataTo && dataTo < today ? dataTo : CA_iso_(CA_addDays_(CA_d_(today), -1));
}

/** Targets tab → { zones: {ZONE: {rev: lacs/month or null, gp: fraction or null}}, total: {...} } */
function CA_readTargets_(ss) {
  var sh = ss.getSheetByName(CA_.TARGETS_SHEET);
  var t = { zones: {}, total: { rev: CA_seed_('TOTAL'), gp: null } };
  Object.keys(CA_.SEED_TARGETS_LACS).forEach(function (k) { if (k !== 'TOTAL') t.zones[k] = { rev: CA_.SEED_TARGETS_LACS[k], gp: null }; });
  if (!sh || sh.getLastRow() < 2) return t;
  sh.getRange(2, 1, sh.getLastRow() - 1, 3).getValues().forEach(function (r) {
    var z = String(r[0] || '').replace(/\s+/g, ' ').trim().toUpperCase();
    if (!z) return;
    var rev = r[1] === '' || r[1] == null ? null : Number(r[1]);
    var gp = r[2] === '' || r[2] == null ? null : Number(r[2]);
    if (gp != null && gp > 1) gp = gp / 100;   // typed as 24.2 instead of 24.2%
    if (z === 'TOTAL') { t.total.rev = rev != null && isFinite(rev) ? rev : null; if (gp != null && isFinite(gp)) t.total.gp = gp; return; }
    t.zones[CA_zk_(z)] = { rev: rev != null && isFinite(rev) ? rev : null, gp: gp != null && isFinite(gp) ? gp : null };
  });
  return t;
}


/* ================================ the numbers ================================ */

/**
 * rows: [{d:'yyyy-mm-dd', z, b, c, rev, gp}] in Rs. targets: from CA_readTargets_. today: 'yyyy-mm-dd'.
 * Pure function (no Google services), so it can be tested outside Apps Script.
 */
function CA_build_(rows, targets, today) {
  var L = 100000;   // Rs per Lac
  var t = CA_d_(today);
  var dataTo = rows.reduce(function (m, r) { return r.d > m ? r.d : m; }, '');
  var cut = dataTo && dataTo < today ? dataTo : CA_iso_(CA_addDays_(t, -1));   // last full day with data

  var dow = (t.getUTCDay() + 6) % 7;                         // Monday = 0
  var thisMon = CA_addDays_(t, -dow);
  var P = {
    lw: [CA_iso_(CA_addDays_(thisMon, -7)), CA_iso_(CA_addDays_(thisMon, -1))],
    pw4: [CA_iso_(CA_addDays_(thisMon, -35)), CA_iso_(CA_addDays_(thisMon, -8))],
    pw: [CA_iso_(CA_addDays_(thisMon, -14)), CA_iso_(CA_addDays_(thisMon, -8))],
    tw: [CA_iso_(thisMon), CA_iso_(CA_addDays_(thisMon, 6))],
    twDone: [CA_iso_(thisMon), cut < CA_iso_(thisMon) ? CA_iso_(CA_addDays_(thisMon, -1)) : cut]
  };
  var mStart = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), 1));
  var mEnd = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0));
  var mtdTo = cut >= CA_iso_(mStart) ? cut : null;
  P.mtd = [CA_iso_(mStart), mtdTo || CA_iso_(CA_addDays_(mStart, -1))];
  var dayN = mtdTo ? CA_d_(mtdTo).getUTCDate() : 0;
  var lmStart = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() - 1, 1));
  var lmEnd = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), 0));
  P.lmtd = [CA_iso_(lmStart), CA_iso_(new Date(Date.UTC(lmStart.getUTCFullYear(), lmStart.getUTCMonth(), Math.min(dayN, lmEnd.getUTCDate()))))];
  P.month = [CA_iso_(mStart), CA_iso_(mEnd)];

  /* ---- zone list: zones with revenue in the last 5 weeks or the month, biggest first ---- */
  var zoneRev = {};
  rows.forEach(function (r) { if (r.d >= P.pw4[0]) zoneRev[r.z] = (zoneRev[r.z] || 0) + r.rev; });
  var tz_ = function (z) { return targets.zones[CA_zk_(z)]; };
  var zones = Object.keys(zoneRev).filter(function (z) { return zoneRev[z] > 0 || tz_(z); })
    .sort(function (a, b) { return zoneRev[b] - zoneRev[a]; });

  /* ---- monthly target per zone: typed value, else company target split by 3-month share ---- */
  var share = {}, gp3 = {}, shareTot = 0, gpTot = 0, s3 = CA_iso_(new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() - 3, 1)));
  var base3 = rows.filter(function (r) { return r.d >= s3 && r.d < P.month[0]; });
  if (!base3.length) base3 = rows;
  base3.forEach(function (r) { share[r.z] = (share[r.z] || 0) + r.rev; shareTot += r.rev; gp3[r.z] = (gp3[r.z] || 0) + r.gp; gpTot += r.gp; });
  var gpHold = function (z) { return z == null ? (shareTot ? gpTot / shareTot : null) : (share[z] ? gp3[z] / share[z] : null); };
  var typed = zones.filter(function (z) { return tz_(z) && tz_(z).rev != null; });
  var typedSum = typed.reduce(function (s, z) { return s + tz_(z).rev; }, 0);
  var restShare = zones.filter(function (z) { return typed.indexOf(z) < 0; }).reduce(function (s, z) { return s + (share[z] || 0); }, 0);
  var left = Math.max(0, (targets.total.rev || 0) - typedSum);
  var tgt = {};
  zones.forEach(function (z) {
    var tz = tz_(z) || {};
    var auto = tz.rev == null, autoGp = tz.gp == null;
    tgt[z] = {
      month: auto ? (restShare ? left * (share[z] || 0) / restShare : 0) : tz.rev,
      gp: autoGp ? gpHold(z) : tz.gp,
      basis: 'Revenue: ' + (auto ? 'TOTAL split by last 3 months share' : 'Targets tab') +
             ' | GP %: ' + (autoGp ? 'last 3 months level' : 'Targets tab')
    };
  });
  var monthSum = zones.reduce(function (s, z) { return s + tgt[z].month; }, 0);
  var tgtTotal = { month: monthSum, gp: targets.total.gp != null ? targets.total.gp :
    (monthSum ? zones.reduce(function (s, z) { return s + tgt[z].month * (tgt[z].gp || 0); }, 0) / monthSum : gpHold(null)) };

  /** target (Lacs) for a date range = sum of daily targets (monthly / days in that month) */
  var tgtFor = function (monthly, a, b) {
    if (!a || !b || b < a) return 0;
    var sum = 0;
    for (var d = CA_d_(a); CA_iso_(d) <= b; d = CA_addDays_(d, 1)) {
      var dim = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
      sum += monthly / dim;
    }
    return sum;
  };

  /* ---- sums ---- */
  var sum = function (a, b, keyFn) {
    var o = {};
    rows.forEach(function (r) {
      if (r.d < a || r.d > b) return;
      var k = keyFn(r), x = o[k] || (o[k] = { rev: 0, gp: 0, n: 0, last: '' });
      x.rev += r.rev; x.gp += r.gp; x.n++; if (r.d > x.last) x.last = r.d;
    });
    return o;
  };
  var byZone = function (p) { return sum(p[0], p[1], function (r) { return r.z; }); };
  var tot = function (o) { var x = { rev: 0, gp: 0 }; Object.keys(o).forEach(function (k) { x.rev += o[k].rev; x.gp += o[k].gp; }); return x; };
  var get = function (o, k) { return o[k] || { rev: 0, gp: 0 }; };
  var pct = function (a, b) { return b ? a / b : null; };
  var status = function (ach) { return ach == null ? '' : ach >= CA_.ACHIEVED_PCT ? 'Achieved' : ach >= CA_.CLOSE_PCT ? 'Close' : 'Missed'; };

  /* ---- 1. where we stand, month to date ---- */
  var mtd = byZone(P.mtd), lmtd = byZone(P.lmtd);
  var standRow = function (name, cur, last, mt, gpT) {
    var mtdT = mtdTo ? tgtFor(mt, P.mtd[0], P.mtd[1]) : 0;
    var ach = pct(cur.rev / L, mtdT);
    return { zone: name, monthT: mt, mtdT: mtdT, rev: cur.rev / L, ach: ach, miss: Math.max(0, mtdT - cur.rev / L),
             gp: cur.gp / L, gpPct: pct(cur.gp, cur.rev), gpT: gpT, lm: last.rev / L, vsLm: last.rev ? cur.rev / last.rev - 1 : null,
             status: status(ach) };
  };
  var stand = zones.map(function (z) { return standRow(z, get(mtd, z), get(lmtd, z), tgt[z].month, tgt[z].gp); });
  var standTot = standRow('TOTAL', tot(mtd), tot(lmtd), tgtTotal.month, tgtTotal.gp);

  /* ---- 2. last week: goal vs achievement ---- */
  var lw = byZone(P.lw), pw = byZone(P.pw);
  var weekRow = function (name, cur, prev, mt, gpT) {
    var wt = tgtFor(mt, P.lw[0], P.lw[1]);
    var ach = pct(cur.rev / L, wt);
    return { zone: name, target: wt, rev: cur.rev / L, ach: ach, miss: Math.max(0, wt - cur.rev / L),
             gp: cur.gp / L, gpPct: pct(cur.gp, cur.rev), gpT: gpT, wow: prev.rev ? cur.rev / prev.rev - 1 : null, status: status(ach) };
  };
  var last = zones.map(function (z) { return weekRow(z, get(lw, z), get(pw, z), tgt[z].month, tgt[z].gp); });
  var lastTot = weekRow('TOTAL', tot(lw), tot(pw), tgtTotal.month, tgtTotal.gp);

  /* ---- 3. this week: goals ---- */
  var tw = byZone(P.twDone);
  var daysLeft = Math.max(0, Math.round((CA_d_(P.tw[1]) - CA_d_(P.twDone[1])) / 86400000));
  var mDaysLeft = Math.max(0, Math.round((mEnd - CA_d_(mtdTo || CA_iso_(CA_addDays_(mStart, -1)))) / 86400000));
  var thisRow = function (name, done, mt, mDone) {
    var wt = tgtFor(mt, P.tw[0], P.tw[1]);
    var bal = Math.max(0, wt - done.rev / L), mBal = Math.max(0, mt - mDone.rev / L);
    return { zone: name, target: wt, done: done.rev / L, balance: bal, perDay: daysLeft ? bal / daysLeft : null,
             monthBal: mBal, monthPerDay: mDaysLeft ? mBal / mDaysLeft : null };
  };
  var thisW = zones.map(function (z) { return thisRow(z, get(tw, z), tgt[z].month, get(mtd, z)); });
  var thisTot = thisRow('TOTAL', tot(tw), tgtTotal.month, tot(mtd));

  /* ---- customers and branches: last week vs average of the 4 weeks before ---- */
  var custLw = sum(P.lw[0], P.lw[1], function (r) { return r.c + '\u0001' + r.z; });
  var cust4 = sum(P.pw4[0], P.pw4[1], function (r) { return r.c + '\u0001' + r.z; });
  var brLw = sum(P.lw[0], P.lw[1], function (r) { return r.b + '\u0001' + r.z; });
  var br4 = sum(P.pw4[0], P.pw4[1], function (r) { return r.b + '\u0001' + r.z; });
  var drops = function (now, base) {
    return Object.keys(base).map(function (k) {
      var avg = base[k].rev / 4, cur = get(now, k).rev, p = k.split('\u0001');
      return { name: p[0], zone: p[1], avg: avg / L, cur: cur / L, drop: (avg - cur) / L };
    }).filter(function (x) { return x.avg * 4 >= CA_.MIN_CUSTOMER_LACS && x.drop > 0; })
      .sort(function (a, b) { return b.drop - a.drop; });
  };
  var custDrops = drops(custLw, cust4), brDrops = drops(brLw, br4);

  var cust4w = sum(P.pw4[0], P.lw[1], function (r) { return r.c + '\u0001' + r.z; });
  var lowGp = Object.keys(cust4w).map(function (k) {
    var x = cust4w[k], p = k.split('\u0001'), g = pct(x.gp, x.rev), gt = (tgt[p[1]] || tgtTotal).gp || 0;
    return { name: p[0], zone: p[1], rev: x.rev / L, gpPct: g, gap: g == null ? 0 : (gt - g) * x.rev / L };
  }).filter(function (x) { return x.rev >= CA_.MIN_CUSTOMER_LACS && x.gpPct != null && x.gpPct < CA_.LOW_GP_PCT; })
    .sort(function (a, b) { return b.gap - a.gap; });

  /* ---- 4. action tracker points ---- */
  var pts = [];
  var lac = function (v) { return CA_lac_(v); };
  if (standTot.ach != null && standTot.ach < CA_.ACHIEVED_PCT && thisTot.monthPerDay != null) {
    var runRate = dayN ? standTot.rev / dayN : 0;
    pts.push({ point: 'Month target needs ' + lac(thisTot.monthPerDay) + ' L/day; run rate ' + lac(runRate) + ' L/day',
               zone: 'All', value: standTot.ach, fmt: 'pct', status: thisTot.monthPerDay > runRate * 1.05 ? 'Off Track' : 'Watch' });
  }
  last.filter(function (r) { return r.status === 'Missed'; }).sort(function (a, b) { return b.miss - a.miss; }).forEach(function (r) {
    pts.push({ point: 'Weekly target missed by ' + lac(r.miss) + ' L', zone: r.zone, value: r.ach, fmt: 'pct', status: 'Off Track' });
  });
  last.filter(function (r) { return r.gpPct != null && r.gpT != null && r.rev > 0 && r.gpPct < r.gpT - 0.01; }).sort(function (a, b) { return a.gpPct - b.gpPct; }).forEach(function (r) {
    pts.push({ point: 'GP % ' + CA_pct1_(r.gpPct) + ' vs target ' + CA_pct1_(r.gpT), zone: r.zone, value: r.gpPct, fmt: 'pct', status: r.gpPct < r.gpT - 0.03 ? 'Off Track' : 'Watch' });
  });
  custDrops.slice(0, 3).forEach(function (x) {
    pts.push({ point: x.name + ': down ' + lac(x.drop) + ' L vs 4-week avg', zone: x.zone, value: -x.drop, fmt: 'lac', status: 'Watch' });
  });
  pts = pts.slice(0, CA_.ACTION_POINTS);

  /* ---- 5. action plan: where to work (largest Rs gap first), with the consignors behind each branch drop ---- */
  var K = '\u0001';
  var bcLw = sum(P.lw[0], P.lw[1], function (r) { return r.b + K + r.z + K + r.c; });
  var bc4 = sum(P.pw4[0], P.pw4[1], function (r) { return r.b + K + r.z + K + r.c; });
  var mainBranch = {};   // consignor|zone -> branch with most revenue in the 5 weeks
  Object.keys(bc4).forEach(function (k) {
    var p = k.split(K), ck = p[2] + K + p[1];
    if (!mainBranch[ck] || bc4[k].rev > mainBranch[ck].rev) mainBranch[ck] = { b: p[0], rev: bc4[k].rev };
  });
  var brCust = {};       // branch|zone -> consignors that dropped, biggest first
  Object.keys(bc4).forEach(function (k) {
    var p = k.split(K), d = (bc4[k].rev / 4 - get(bcLw, k).rev) / L;
    if (d <= 0) return;
    (brCust[p[0] + K + p[1]] = brCust[p[0] + K + p[1]] || []).push({ name: p[2], drop: d });
  });
  var names = function (list) {
    return (list || []).sort(function (a, b) { return b.drop - a.drop; }).slice(0, CA_.PLAN_CONSIGNORS)
      .map(function (x) { return x.name + ' (' + lac(x.drop) + ')'; }).join(', ');
  };
  var plan = [];
  var missedZones = {};
  last.concat(stand).forEach(function (r) { if (r.status === 'Missed' || r.status === 'Close') missedZones[r.zone] = true; });
  brDrops.filter(function (x) { return missedZones[x.zone]; }).slice(0, 7).forEach(function (x) {
    plan.push({ zone: x.zone, branch: x.name, who: names(brCust[x.name + K + x.zone]), gap: x.drop,
                action: 'Recover branch volume; call the consignors listed' });
  });
  custDrops.slice(0, 8).forEach(function (x) {
    var mb = mainBranch[x.name + K + x.zone];
    plan.push({ zone: x.zone, branch: mb ? mb.b : '', who: x.name + ' (' + lac(x.drop) + ')', gap: x.drop,
                action: 'Call customer; check rate, service and lost lanes' });
  });
  lowGp.slice(0, 3).forEach(function (x) {
    var mb = mainBranch[x.name + K + x.zone];
    plan.push({ zone: x.zone, branch: mb ? mb.b : '', who: x.name + ' (GP ' + CA_pct1_(x.gpPct) + ')', gap: x.gap,
                action: 'Revise rate or cut cost on this account' });
  });
  plan.sort(function (a, b) { return b.gap - a.gap; });
  plan = plan.slice(0, CA_.ACTION_PLAN_ROWS);

  /* ---- 9. lost customers: business last month, nothing this month ---- */
  P.lm = [CA_iso_(lmStart), CA_iso_(lmEnd)];
  var keyCZ = function (r) { return r.c + K + r.z; };
  var lmC = sum(P.lm[0], P.lm[1], keyCZ), mtdC = sum(P.mtd[0], P.mtd[1], keyCZ);
  var lastSeen = sum('0000', '9999', keyCZ);
  var lmBr = {};
  rows.forEach(function (r) {
    if (r.d < P.lm[0] || r.d > P.lm[1]) return;
    var k = keyCZ(r), o = lmBr[k] || (lmBr[k] = {});
    o[r.b] = (o[r.b] || 0) + r.rev;
  });
  var topKey = function (o) { return Object.keys(o || {}).sort(function (a, b) { return o[b] - o[a]; })[0] || ''; };
  var cutD = CA_d_(cut);
  var lost = Object.keys(lmC).filter(function (k) {
    return lmC[k].rev >= CA_.LOST_MIN_LACS * L && get(mtdC, k).rev <= 0;
  }).map(function (k) {
    var p = k.split(K), ls = lastSeen[k].last;
    return { zone: p[1], branch: topKey(lmBr[k]), name: p[0], lmRev: lmC[k].rev / L, lmGrs: lmC[k].n,
             lmGpPct: pct(lmC[k].gp, lmC[k].rev), lastGr: ls, days: ls ? Math.round((cutD - CA_d_(ls)) / 86400000) : null };
  }).sort(function (a, b) { return b.lmRev - a.lmRev; });
  var lostTotal = lost.reduce(function (s2, x) { return s2 + x.lmRev; }, 0);
  var lostCount = lost.length;
  lost = lost.slice(0, CA_.LOST_ROWS);

  /* ---- 10. negative GP consignors, month to date ---- */
  var mtdBr = {};
  rows.forEach(function (r) {
    if (r.d < P.mtd[0] || r.d > P.mtd[1]) return;
    var k = keyCZ(r), o = mtdBr[k] || (mtdBr[k] = {});
    o[r.b] = (o[r.b] || 0) + r.rev;
  });
  var negGp = Object.keys(mtdC).filter(function (k) { return mtdC[k].rev > 0 && mtdC[k].gp < 0; }).map(function (k) {
    var p = k.split(K), x = mtdC[k];
    return { zone: p[1], branch: topKey(mtdBr[k]), name: p[0], rev: x.rev / L, gp: x.gp / L, gpPct: pct(x.gp, x.rev), grs: x.n };
  }).sort(function (a, b) { return a.gp - b.gp; });
  var negTotal = negGp.reduce(function (s2, x) { return s2 + x.gp; }, 0);
  var negCount = negGp.length;
  negGp = negGp.slice(0, CA_.NEG_GP_ROWS);

  return {
    today: today, dataTo: dataTo, periods: P, mtdDays: dayN, daysLeft: daysLeft, monthDaysLeft: mDaysLeft,
    zones: zones, targets: tgt, targetTotal: tgtTotal,
    stand: stand, standTotal: standTot, last: last, lastTotal: lastTot, thisWeek: thisW, thisTotal: thisTot,
    points: pts, plan: plan,
    lost: lost, lostCount: lostCount, lostTotal: lostTotal, negGp: negGp, negCount: negCount, negTotal: negTotal
  };
}


/* ================================ weekly meeting numbers ================================ */

/**
 * Bullets and the zone gap table for the weekly meeting, from the same rows.
 * rows: CA_rec_ records (Rs, kg). targets: { zones: { ZONE KEY: Lacs/month }, total: Lacs/month }.
 * asOf: last full day with data. Working days = Monday to Saturday. Weeks = Monday to Sunday.
 * Circle target = zone target x the circle's share of the zone's revenue in the last 3 full months.
 * Yield = LTL Total Freight / CWeight (and Basic Freight / CWeight) against the last 2 full months.
 * Pure function (no Google services).
 */
function CA_meeting_(rows, targets, asOf) {
  var MS = CA_MON_, BENCH = 2;
  var D = CA_d_, I = CA_iso_;
  var add = function (iso, n) { return I(CA_addDays_(D(iso), n)); };
  var dow = function (iso) { return (D(iso).getUTCDay() + 6) % 7; };
  var wd = function (a, b) { var n = 0; for (var x = a; x <= b; x = add(x, 1)) if (dow(x) !== 6) n++; return n; };
  var sd = function (n, d) { return (!d || Math.abs(d) < 1e-9) ? 0 : n / d; };
  var title = function (v) {
    return String(v).replace(/\s+circle$/i, '').toLowerCase().replace(/\b[a-z]/g, function (c) { return c.toUpperCase(); })
      .replace(/\bNcr\b/, 'NCR').replace(/\bUp\b/, 'UP').replace(/\bNe\b/, 'NE').replace(/\bMp\b/, 'MP');
  };
  var zShort = function (z) { return title(CA_zk_(z).replace(/ ZONE$/, '').replace(/^ZONE /, '')); };
  var day = function (iso) { var d = D(iso); return ('0' + d.getUTCDate()).slice(-2) + ' ' + MS[d.getUTCMonth()]; };
  var rng = function (a, b) {
    if (a === b) return day(a);
    var x = D(a), y = D(b);
    return x.getUTCMonth() === y.getUTCMonth() ? x.getUTCDate() + '-' + y.getUTCDate() + ' ' + MS[y.getUTCMonth()] : day(a) + ' - ' + day(b);
  };
  var cr = function (v) { return 'Rs ' + (v / 1e7).toFixed(2) + ' Cr'; };
  var lk = function (v) { return 'Rs ' + (v / 1e5).toFixed(1) + ' L'; };
  var pc = function (v) { return (v * 100).toFixed(1) + '%'; };
  var chg = function (a, b) { return b ? a / b - 1 : null; };
  var ORDER = ['NORTH ZONE', 'SOUTH ZONE', 'GUJARAT WEST ZONE', 'WEST ZONE', 'EAST ZONE', 'NORTH EAST ZONE', 'NEPAL ZONE'];

  var y = +asOf.slice(0, 4), mo = +asOf.slice(5, 7);
  var mStart = asOf.slice(0, 8) + '01';
  var mEnd = I(new Date(Date.UTC(y, mo, 0)));
  var b3Start = I(new Date(Date.UTC(y, mo - 4, 1))), b3End = add(mStart, -1);
  var bnStart = I(new Date(Date.UTC(y, mo - 1 - BENCH, 1)));
  var wdMonth = wd(mStart, mEnd), wdDone = wd(mStart, asOf), wdLeft = asOf < mEnd ? wd(add(asOf, 1), mEnd) : 0;
  var dw = dow(asOf), owStart = add(asOf, -dw);
  var lwStart = add(owStart, -7), lwEnd = add(owStart, -1), lwSame = add(lwStart, dw);
  var nwStart = add(asOf, 7 - dw), nwEndRaw = add(nwStart, 5), nwEnd = nwEndRaw < mEnd ? nwEndRaw : mEnd;
  var nwDays = nwStart <= mEnd ? wd(nwStart, nwEnd) : 0;
  var dim = +mEnd.slice(8, 10);

  var S = function () { return { rev: 0, ftl: 0, ltl: 0, lcw: 0, lfr: 0, fcw: 0 }; };
  var put = function (o, r) {
    o.rev += r.rev;
    if (r.lt === 'FTL') { o.ftl += r.rev; o.fcw += r.cw; } else { o.ltl += r.rev; o.lcw += r.cw; o.lfr += r.fr; }
  };
  var mtd = S(), bench = S(), ow = S(), lw = S(), lwS = S();
  var zM = {}, z3 = {}, cM = {}, c3 = {}, daily = {}, zName = {};
  var g = function (m, k) { return m[k] || (m[k] = S()); };
  var dataTo = '';
  rows.forEach(function (r) {
    var d = r.d;
    if (!d || d > asOf) return;
    if (d > dataTo) dataTo = d;
    var z = CA_zk_(r.z), ck = z + '\u0001' + (r.ci || 'UNSPECIFIED');
    if (!zName[z]) zName[z] = String(r.z || '').trim().toUpperCase();
    if (d >= mStart) { put(mtd, r); put(g(zM, z), r); put(g(cM, ck), r); daily[d] = (daily[d] || 0) + r.rev; }
    else {
      if (d >= b3Start && d <= b3End) { put(g(z3, z), r); put(g(c3, ck), r); }
      if (d >= bnStart && d <= b3End) put(bench, r);
    }
    if (d >= owStart) put(ow, r);
    if (d >= lwStart && d <= lwEnd) { put(lw, r); if (d <= lwSame) put(lwS, r); }
    if (d >= add(owStart, -35) && d < mStart) daily[d] = (daily[d] || 0) + r.rev;
  });

  /* ---- targets (Lacs → Rs) ---- */
  var tz = targets.zones || {};
  var keys = {};
  Object.keys(zM).concat(Object.keys(tz)).forEach(function (z) {
    if (z && z !== 'UNSPECIFIED' && ((tz[z] || 0) > 0 || (zM[z] || {}).rev > 0)) keys[z] = true;
  });
  var zoneKeys = Object.keys(keys).sort(function (a, b) {
    var ia = ORDER.indexOf(a), ib = ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || ((zM[b] || { rev: 0 }).rev - (zM[a] || { rev: 0 }).rev);
  });
  var zoneSum = zoneKeys.reduce(function (s, z) { return s + (tz[z] || 0); }, 0);
  var T = (targets.total != null && targets.total > 0 ? targets.total : zoneSum) * 1e5;
  var gap = Math.max(0, T - mtd.rev), need = wdLeft ? gap / wdLeft : 0, run = sd(mtd.rev, wdDone), pace = sd(wdDone, wdMonth);

  var zones = zoneKeys.map(function (z) {
    var t = (tz[z] || 0) * 1e5, a = zM[z] || S(), gz = Math.max(0, t - a.rev), ask = wdLeft ? gz / wdLeft : 0;
    return { key: z, name: zName[z] || (z + ' RO'), short: zShort(z), target: t, rev: a.rev, pct: t ? a.rev / t : null, gap: gz, ask: ask, week: ask * nwDays };
  });
  var total = { key: 'PAN INDIA', name: 'Pan India', short: 'Pan India', target: T, rev: mtd.rev, pct: sd(mtd.rev, T), gap: gap, ask: need, week: need * nwDays };

  var circles = [];
  Object.keys(cM).forEach(function (ck) {
    var p = ck.split('\u0001'), z = p[0], c = p[1];
    if (!c || c === 'UNSPECIFIED' || c === '-') return;
    var zt = (tz[z] || 0) * 1e5, zb = (z3[z] || { rev: 0 }).rev, cb = (c3[ck] || { rev: 0 }).rev;
    if (!zt || !zb || !cb) return;
    var share = cb / zb, t = zt * share, a = cM[ck];
    circles.push({ zone: z, name: title(c), share: share, target: t, rev: a.rev, pct: a.rev / t, gap: Math.max(0, t - a.rev) });
  });
  var circlesOf = function (z) { var l = circles.filter(function (c) { return c.zone === z && c.share >= 0.05; }); return l.length > 1 ? l : []; };

  var best = null;
  Object.keys(daily).forEach(function (d) { if (d >= mStart && (!best || daily[d] > best.v)) best = { d: d, v: daily[d] }; });
  var ty = sd(mtd.ltl, mtd.lcw), by = sd(mtd.lfr, mtd.lcw), bty = sd(bench.ltl, bench.lcw), bby = sd(bench.lfr, bench.lcw);
  var fty = sd(mtd.ftl, mtd.fcw), bfty = sd(bench.ftl, bench.fcw);
  var benchLab = MS[+bnStart.slice(5, 7) - 1] + '-' + MS[+b3End.slice(5, 7) - 1];

  /* ---- the numbers ---- */
  var M = [];
  M.push({ t: 'Revenue: ' + cr(mtd.rev) + ' booked against a ' + cr(T) + ' target, which is ' + pc(total.pct) + ' achieved (' +
    pc(pace) + ' of the month’s working days are gone). FTL is ' + cr(mtd.ftl) + ' and LTL is ' + cr(mtd.ltl) + '.' });
  if (wdLeft) {
    M.push({ t: 'Run-rate gap: Current run-rate is ' + lk(run) + '/day, but we need ' + lk(need) + '/day for the remaining ' + wdLeft + ' working days.' +
      (best ? ' Our best day this month was ' + lk(best.v) + ' (' + day(best.d) + ')' + (need > best.v ? ', so the target needs a record run.' : ', so the target is within reach at our best-day pace.') : '') });
  } else {
    M.push({ t: 'Month closed: ' + cr(mtd.rev) + ' against ' + cr(T) + (gap > 0 ? ', short by ' + cr(gap) : ', target achieved') + '.' +
      (best ? ' Best day was ' + lk(best.v) + ' (' + day(best.d) + ').' : '') });
  }
  var ranked = zones.filter(function (z) { return z.pct != null && z.target > 0; });
  var low = ranked.slice().sort(function (a, b) { return a.pct - b.pct; }).filter(function (z) { return z.pct < total.pct; }).slice(0, 3);
  var sub = function (list, n, asc) {
    return list.slice().sort(function (a, b) { return asc ? a.pct - b.pct : b.pct - a.pct; }).slice(0, n)
      .map(function (c) { return c.name + ' ' + pc(c.pct); }).join(', ');
  };
  if (low.length) {
    M.push({ t: 'Where we’re stuck:' });
    low.forEach(function (z) { var s2 = sub(circlesOf(z.key), 2, true); M.push({ t: z.short + ' is at ' + pc(z.pct) + (s2 ? ' (' + s2 + ')' : '') + '.', sub: true }); });
  }
  var big = ranked.slice().sort(function (a, b) { return b.gap - a.gap; })[0];
  if (big && big.gap > 0) {
    var bc = circlesOf(big.key).sort(function (a, b) { return b.gap - a.gap; })[0];
    M.push({ t: big.short + ' has the biggest absolute gap of ' + cr(big.gap) + ', ' + (low.indexOf(big) >= 0 ? 'at' : 'even at') + ' ' + pc(big.pct) + '.' +
      (bc && bc.gap > 0 ? ' ' + bc.name + ' alone is ' + cr(bc.gap) + ' behind.' : ''), sub: low.length > 0 });
  }
  var high = ranked.slice().sort(function (a, b) { return b.pct - a.pct; }).filter(function (z) { return z.pct >= total.pct && low.indexOf(z) < 0; }).slice(0, 1);
  if (high.length) {
    var hz = high[0], hs = sub(circlesOf(hz.key), 2, false);
    var others = circles.filter(function (c) { return c.zone !== hz.key && c.share >= 0.05 && circlesOf(c.zone).length && c.target >= 0.005 * T && c.pct > total.pct; })
      .sort(function (a, b) { return b.pct - a.pct; }).slice(0, 2);
    M.push({ t: 'Working well: ' + hz.short + ' is at ' + pc(hz.pct) + (hs ? ', with ' + hs.replace(/, ([^,]*)$/, ' and $1') : '') + '.' +
      (others.length ? ' ' + others.map(function (c) { return c.name + ' (' + pc(c.pct) + ')'; }).join(' and ') + ' ' + (others.length > 1 ? 'are' : 'is') + ' also ahead.' : '') });
  }
  if (bty) {
    var yOk = ty >= bty * 0.98, vOk = total.pct >= pace * 0.98;
    var verdict = yOk && !vOk ? 'Yield is not the problem, volume is' : !yOk && vOk ? 'Volume is on track, yield is the problem' : !yOk && !vOk ? 'Both volume and yield are behind' : 'Volume and yield are both on track';
    var bw = by >= bby ? 'which is above' : (by >= bby * 0.98 ? 'which is only slightly below' : 'which is below');
    M.push({ t: verdict + ': LTL total yield is Rs ' + ty.toFixed(2) + ' against a Rs ' + bty.toFixed(2) + ' benchmark (' + benchLab + '). Basic yield is Rs ' +
      by.toFixed(2) + ' against Rs ' + bby.toFixed(2) + ', ' + bw + '.' + (bfty ? ' FTL total yield is Rs ' + fty.toFixed(2) + ' against Rs ' + bfty.toFixed(2) + '.' : '') });
  }

  /* ---- weekly ---- */
  var W = [], perDayT = T / dim;
  var wGoal = function (a, b) { var n = 0; for (var x = a; x <= b; x = add(x, 1)) n++; return n * perDayT; };
  var owGoal = wGoal(owStart, add(owStart, 6)), lwGoal = wGoal(lwStart, lwEnd);
  var owFull = dw === 6;
  var lwDays = [];
  for (var x = lwStart; x <= lwEnd; x = add(x, 1)) lwDays.push({ d: x, v: daily[x] || 0 });
  var wkd = lwDays.filter(function (q) { return dow(q.d) < 5 && q.v > 0; }), sat = lwDays.filter(function (q) { return dow(q.d) === 5; })[0];
  var vals = wkd.map(function (q) { return q.v; });
  W.push({ t: 'Last week (' + rng(lwStart, lwEnd) + '): ' + cr(lw.rev) + ', which is about ' + Math.round(sd(lw.rev, lwGoal) * 100) + '% of the weekly goal of ' + cr(lwGoal) + '.' +
    (vals.length ? ' Weekdays ran Rs ' + (Math.min.apply(null, vals) / 1e5).toFixed(0) + '-' + (Math.max.apply(null, vals) / 1e5).toFixed(0) + ' L/day' : '') +
    (sat && sat.v ? ', and Saturday was ' + lk(sat.v) + '.' : (vals.length ? '.' : '')) });
  var cmpB = owFull ? lw : lwS, cmpLab = owFull ? 'last week' : (dw ? 'the same ' + (dw + 1) + ' days last week' : 'last Monday');
  var c1 = chg(ow.rev, cmpB.rev);
  W.push({ t: 'This week (' + rng(owStart, asOf) + (owFull ? '' : ', ' + (dw + 1) + ' day' + (dw ? 's' : '') + ' so far') + '): ' + cr(ow.rev) +
    ', which is about ' + Math.round(sd(ow.rev, owGoal) * 100) + '% of the weekly goal' +
    (c1 == null ? '.' : ' and ' + Math.abs(c1 * 100).toFixed(0) + '% ' + (c1 >= 0 ? 'higher' : 'lower') + ' than ' + cmpLab + ' (' + cr(cmpB.rev) + ').') });
  var cf = chg(ow.ftl, cmpB.ftl), cl = chg(ow.ltl, cmpB.ltl);
  if (cf != null && cl != null) {
    var w = function (n, c, a, b) { return n + ' ' + (c >= 0 ? 'rose' : 'fell') + ' ' + Math.abs(c * 100).toFixed(0) + '% (' + cr(a) + ' to ' + cr(b) + ')'; };
    W.push({ t: 'FTL vs LTL: ' + w('FTL', cf, cmpB.ftl, ow.ftl) + '. ' + w('LTL', cl, cmpB.ltl, ow.ltl) + ', so ' +
      (cf >= 0 && cl >= 0 ? (cf > cl ? 'FTL' : 'LTL') + ' is growing faster' : (cf < cl ? 'FTL' : 'LTL') + ' is the weaker segment') + '.' });
  }
  var bestWk = null;
  for (var k = 1; k <= 5; k++) {
    var a0 = add(owStart, -7 * k), v = 0;
    for (var x2 = a0; x2 <= add(a0, 6); x2 = add(x2, 1)) v += daily[x2] || 0;
    if (!bestWk || v > bestWk.v) bestWk = { a: a0, v: v };
  }
  if (nwDays && wdLeft) {
    W.push({ t: 'Coming week (' + rng(nwStart, nwEnd) + '): We need about ' + cr(need * nwDays) + ' (' + lk(need) + ' x ' + nwDays + ' days) just to stay on track' +
      (bestWk && bestWk.v ? ', versus ' + cr(bestWk.v) + ' in our best recent week (' + rng(bestWk.a, add(bestWk.a, 6)) + ').' : '.') });
  } else if (wdLeft) {
    W.push({ t: 'Rest of the month (' + wdLeft + ' working days): We need ' + cr(gap) + ' (' + lk(need) + '/day) to close the target.' });
  }

  var dn = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'][dw];
  return {
    asOf: asOf, wdLeft: wdLeft, nwDays: nwDays, zones: zones, total: total, monthBullets: M, weekBullets: W,
    labels: {
      month: 'Current month (' + rng(mStart, asOf) + ', data till ' + dn + ' ' + day(asOf) + ')',
      week: 'Weekly: this week (' + rng(owStart, asOf) + ') vs last week (' + rng(lwStart, lwEnd) + ')',
      nextWeek: nwDays ? 'Week (' + rng(nwStart, nwEnd) + ') Goal' : 'Rest of Month Goal'
    }
  };
}


/* ================================ sheet out ================================ */

function CA_writeTargets_(ss, m) {
  var sh = ss.getSheetByName(CA_.TARGETS_SHEET);
  var fresh = !sh;
  if (fresh) sh = ss.insertSheet(CA_.TARGETS_SHEET);
  var head = ['Zone', 'Monthly Revenue Target (Rs Lacs)', 'GP % Target', 'Revenue Target used (Rs Lacs)', 'GP % Target used', 'Basis'];
  var have = {};
  if (!fresh && sh.getLastRow() > 1) {
    sh.getRange(2, 1, sh.getLastRow() - 1, 3).getValues().forEach(function (r, i) {
      var z = String(r[0] || '').trim().toUpperCase(); if (z) have[z === 'TOTAL' ? z : CA_zk_(z)] = { row: i + 2, rev: r[1], gp: r[2] };
    });
  }
  var list = m.zones.concat(['TOTAL']);
  var nz = function (v) { return v == null ? '' : v; };
  var out = list.map(function (z) {
    var h = have[z === 'TOTAL' ? z : CA_zk_(z)] || { rev: nz(CA_seed_(z)) };
    if (z === 'TOTAL') {
      return ['TOTAL', h.rev,
              h.gp === undefined ? '' : h.gp, m.targetTotal.month, nz(m.targetTotal.gp), 'Sum of zones'];
    }
    return [z, h.rev === undefined ? '' : h.rev, h.gp === undefined ? '' : h.gp, m.targets[z].month, nz(m.targets[z].gp), m.targets[z].basis];
  });
  sh.clearContents();
  sh.getRange(1, 1, 1, head.length).setValues([head]);
  sh.getRange(2, 1, out.length, head.length).setValues(out);
  var n = out.length;
  sh.getRange(1, 1, n + 1, head.length).setFontFamily('Arial').setFontSize(10).setVerticalAlignment('middle');
  sh.getRange(1, 1, 1, head.length).setBackground(CA_COLORS_.head).setFontColor(CA_COLORS_.headText).setFontWeight('bold').setWrap(true);
  sh.getRange(2, 2, n, 1).setNumberFormat('#,##0.00').setFontColor('#0000FF');
  sh.getRange(2, 3, n, 1).setNumberFormat('0.0%').setFontColor('#0000FF');
  sh.getRange(2, 4, n, 1).setNumberFormat('#,##0.00').setFontColor('#000000');
  sh.getRange(2, 5, n, 1).setNumberFormat('0.0%').setFontColor('#000000');
  sh.getRange(2, 6, n, 1).setFontColor(CA_COLORS_.sub);
  sh.getRange(n + 1, 1, 1, head.length).setFontWeight('bold').setBackground(CA_COLORS_.total);
  sh.getRange(1, 1, n + 1, head.length).setBorder(true, true, true, true, true, true, CA_COLORS_.line, SpreadsheetApp.BorderStyle.SOLID);
  sh.setColumnWidth(1, 220); sh.setColumnWidths(2, 4, 150); sh.setColumnWidth(6, 360);
  sh.setFrozenRows(1);
  sh.getRange(n + 3, 1).setValue('Blue cells are inputs. Blank revenue: TOTAL split by last 3 months share. Blank GP %: last 3 months level.')
    .setFontColor(CA_COLORS_.sub).setFontFamily('Arial').setFontSize(9);
}

function CA_render_(ss, m, stamp) {
  var sh = ss.getSheetByName(CA_.SHEET) || ss.insertSheet(CA_.SHEET, 0);
  var manual = CA_readManual_(sh);
  if (!Object.keys(manual).length) manual = CA_readManual_(ss.getSheetByName(CA_.MANUAL_SEED_SHEET));
  sh.getRange(1, 1, sh.getMaxRows(), sh.getMaxColumns()).breakApart();
  sh.clear();
  sh.getRange(1, 1, sh.getMaxRows(), sh.getMaxColumns()).setFontFamily('Arial').setFontSize(10).setVerticalAlignment('middle');
  sh.setHiddenGridlines(true);
  var W = 10;   // columns A:J
  var r = 1;
  var P = m.periods;

  sh.getRange(r, 1).setValue('Sales Review').setFontSize(16).setFontWeight('bold').setFontColor(CA_COLORS_.title);
  r++;
  sh.getRange(r, 1).setValue('Data up to ' + CA_fmtDay_(m.dataTo) + '   |   Last week ' + CA_fmtRange_(P.lw) +
    '   |   This week ' + CA_fmtRange_(P.tw) + '   |   Updated ' + stamp + '   |   Rs in Lacs')
    .setFontSize(9).setFontColor(CA_COLORS_.sub);
  r += 2;

  /* A block: title line, header row, data rows. opts.spans lets a text column cover several sheet columns. */
  var block = function (title, head, rows, formats, opts) {
    opts = opts || {};
    var spans = opts.spans || head.map(function () { return 1; });
    var at = [], c = 1;
    spans.forEach(function (sp) { at.push(c); c += sp; });
    var width = c - 1;
    var put = function (row, vals, n) {
      vals.forEach(function (v, j) {
        var rg = sh.getRange(row, at[j], n, spans[j]);
        if (spans[j] > 1) rg.mergeAcross();
        sh.getRange(row, at[j], n, 1).setValues(n === 1 && !Array.isArray(v) ? [[v]] : v);
      });
    };
    sh.getRange(r, 1, 1, W).setBorder(null, null, true, null, null, null, CA_COLORS_.block, SpreadsheetApp.BorderStyle.SOLID_MEDIUM);
    sh.getRange(r, 1).setValue(title).setFontSize(11).setFontWeight('bold').setFontColor(CA_COLORS_.block);
    r++;
    put(r, head, 1);
    sh.getRange(r, 1, 1, width).setBackground(CA_COLORS_.head).setFontColor(CA_COLORS_.headText)
      .setFontWeight('bold').setWrap(true).setHorizontalAlignment('center');
    sh.setRowHeight(r, 32);
    r++;
    if (!rows.length) {
      sh.getRange(r, 1).setValue(opts.empty || 'Nothing to show').setFontColor(CA_COLORS_.sub);
      r += 2; return null;
    }
    var n = rows.length;
    put(r, head.map(function (_, j) { return rows.map(function (x) { return [x[j]]; }); }), n);
    sh.getRange(r, 2, n, width - 1).setHorizontalAlignment('right');
    formats.forEach(function (f, j) { if (f) sh.getRange(r, at[j], n, 1).setNumberFormat(f); });
    (opts.left || []).forEach(function (j) { sh.getRange(r, at[j], n, spans[j]).setHorizontalAlignment('left'); });
    sh.getRange(r - 1, 1, n + 1, width).setBorder(true, true, true, true, true, true, CA_COLORS_.line, SpreadsheetApp.BorderStyle.SOLID);
    if (opts.total) sh.getRange(r + n - 1, 1, 1, width).setFontWeight('bold').setBackground(CA_COLORS_.total);
    for (var i = 0; i < n; i++) {
      if (opts.statusCol != null) {
        var v = rows[i][opts.statusCol];
        var col = v === 'Achieved' || v === 'On Track' ? CA_COLORS_.good : v === 'Close' || v === 'Watch' ? CA_COLORS_.warn : v ? CA_COLORS_.bad : null;
        if (col) sh.getRange(r + i, at[opts.statusCol]).setFontColor(col).setFontWeight('bold').setHorizontalAlignment('center');
      }
      (opts.signCols || []).forEach(function (j) {
        if (typeof rows[i][j] === 'number' && rows[i][j] < 0) sh.getRange(r + i, at[j]).setFontColor(CA_COLORS_.bad);
      });
    }
    var first = r;
    r += n + 1;
    return { row: first, at: at };
  };
  var nz = function (v) { return v == null ? '' : v; };
  var LAC = '#,##0.00;(#,##0.00);"-"', PCT = '0.0%;(0.0%);"-"', CHG = '+0.0%;-0.0%;"-"';

  /* 1 */
  block('1. Where we stand: month to date (' + CA_fmtRange_(P.mtd) + ')',
    ['Zone', 'Month Target', 'MTD Target', 'MTD Revenue', '% Ach', 'Target Miss', 'GP', 'GP %', 'vs Last Month (same days)', 'Status'],
    m.stand.concat([m.standTotal]).map(function (x) {
      return [x.zone, x.monthT, x.mtdT, x.rev, nz(x.ach), x.miss, x.gp, nz(x.gpPct), nz(x.vsLm), x.status];
    }),
    [null, LAC, LAC, LAC, PCT, LAC, LAC, PCT, CHG, null], { total: true, statusCol: 9, signCols: [6, 8] });

  /* 2 */
  block('2. Last week: goal vs achievement (' + CA_fmtRange_(P.lw) + ')',
    ['Zone', 'Target', 'Revenue', '% Ach', 'Target Miss', 'GP', 'GP %', 'GP % Target', 'vs Previous Week', 'Status'],
    m.last.concat([m.lastTotal]).map(function (x) {
      return [x.zone, x.target, x.rev, nz(x.ach), x.miss, x.gp, nz(x.gpPct), nz(x.gpT), nz(x.wow), x.status];
    }),
    [null, LAC, LAC, PCT, LAC, LAC, PCT, PCT, CHG, null], { total: true, statusCol: 9, signCols: [5, 8] });

  /* 3 */
  block('3. This week: goals (' + CA_fmtRange_(P.tw) + ', ' + m.daysLeft + ' days left)',
    ['Zone', 'Week Target', 'Done so far', 'Balance', 'Needed per Day', 'Month Balance', 'Needed per Day (month)'],
    m.thisWeek.concat([m.thisTotal]).map(function (x) {
      return [x.zone, x.target, x.done, x.balance, nz(x.perDay), x.monthBal, nz(x.monthPerDay)];
    }),
    [null, LAC, LAC, LAC, LAC, LAC, LAC], { total: true });

  /* 4 */
  var b4 = block('4. Action tracker points',
    ['Zone', 'Point', 'Value', 'Status'],
    m.points.map(function (x) { return [x.zone, x.point, x.value, x.status]; }),
    [null, null, null, null], { spans: [1, 5, 1, 1], statusCol: 3, left: [1], empty: 'All zones on target' });
  if (b4) m.points.forEach(function (x, i) { sh.getRange(b4.row + i, b4.at[2]).setNumberFormat(x.fmt === 'pct' ? PCT : LAC); });

  /* 5 */
  var b5 = block('5. Action plan: where to work (gap = drop vs 4-week average, Rs Lacs)',
    ['Zone', 'Branch', 'Consignors to work on (drop, L)', 'Gap', 'Action'],
    m.plan.map(function (x) { return [x.zone, x.branch, x.who, x.gap, x.action]; }),
    [null, null, null, LAC, null], { spans: [1, 2, 4, 1, 2], left: [1, 2, 4], empty: 'No gap found' });
  if (b5) sh.getRange(b5.row, b5.at[2], m.plan.length, 4).setWrap(true);

  /* 6, 7: meeting bullets (one merged row per bullet) */
  var mt = m.meeting;
  var bullets = function (title, label, list) {
    sh.getRange(r, 1, 1, W).setBorder(null, null, true, null, null, null, CA_COLORS_.block, SpreadsheetApp.BorderStyle.SOLID_MEDIUM);
    sh.getRange(r, 1).setValue(title).setFontSize(11).setFontWeight('bold').setFontColor(CA_COLORS_.block);
    r++;
    sh.getRange(r, 1).setValue(label).setFontWeight('bold').setFontColor(CA_COLORS_.title);
    r++;
    list.forEach(function (b) {
      var text = (b.sub ? '        - ' : '\u2022  ') + b.t;
      sh.getRange(r, 1, 1, W).merge().setValue(text).setWrap(true).setVerticalAlignment('top');
      sh.setRowHeight(r, 18 * Math.max(1, Math.ceil(text.length / 160)) + 4);
      r++;
    });
    r++;
  };
  bullets('6. The numbers', mt.labels.month, mt.monthBullets);
  bullets('7. Last week\u2019s goals & achievements and this week\u2019s goals', mt.labels.week, mt.weekBullets);

  /* 8: zone gap (Rs Cr); By Whom / By When are typed by hand and kept */
  var CR = '0.00;(0.00);"-"';
  var mk = function (z) { var k = CA_zk_(z.name === 'Pan India' ? 'PAN INDIA' : z.name); return manual[k] || ['', '']; };
  var b8 = block('8. Zone gap: daily asking rate and week goal (' + mt.wdLeft + ' working days left, Rs Cr)',
    ['Zone', 'Month Target', 'Revenue so far', '% Achieved', 'GAP against Target', 'Daily Asking Rate', mt.labels.nextWeek, 'By Whom', 'By When'],
    mt.zones.concat([mt.total]).map(function (z) {
      var mm = mk(z);
      return [z.name, z.target / 1e7, z.rev / 1e7, z.pct == null ? '' : z.pct, z.gap / 1e7, z.ask / 1e7, z.week / 1e7, mm[0], mm[1]];
    }),
    [null, CR, CR, PCT, CR, CR, CR, null, null], { spans: [1, 1, 1, 1, 1, 1, 1, 2, 1], total: true, left: [7, 8] });
  if (b8) sh.getRange(b8.row, b8.at[7], mt.zones.length + 1, 3).setFontColor('#0000FF').setWrap(true);

  /* 9: lost customers */
  var DT = 'dd-mmm-yy';
  block('9. Lost customers: business in ' + CA_fmtRange_(P.lm) + ', nothing this month (' + m.lostCount +
    ' consignors, Rs ' + CA_lac_(m.lostTotal) + ' L last month)',
    ['Zone', 'Branch', 'Consignor', 'Last Month Revenue', 'GRs', 'GP %', 'Last GR', 'Days since'],
    m.lost.map(function (x) { return [x.zone, x.branch, x.name, x.lmRev, x.lmGrs, nz(x.lmGpPct), x.lastGr ? CA_d_(x.lastGr) : '', nz(x.days)]; }),
    [null, null, null, LAC, '0', PCT, DT, '0'], { spans: [1, 2, 2, 1, 1, 1, 1, 1], left: [1, 2], empty: 'No lost customer' });

  /* 10: negative GP */
  block('10. Negative GP consignors, month to date (' + m.negCount + ' consignors, GP Rs ' + CA_lac_(m.negTotal) + ' L)',
    ['Zone', 'Branch', 'Consignor', 'MTD Revenue', 'MTD GP', 'GP %', 'GRs'],
    m.negGp.map(function (x) { return [x.zone, x.branch, x.name, x.rev, x.gp, x.gpPct, x.grs]; }),
    [null, null, null, LAC, LAC, PCT, '0'], { spans: [1, 2, 3, 1, 1, 1, 1], left: [1, 2], signCols: [4, 5], empty: 'No negative GP consignor' });

  sh.setColumnWidth(1, 190);
  sh.setColumnWidths(2, W - 1, 104);
  sh.setFrozenRows(2);
}


/* ================================ copies to other sheets ================================ */

/** Sends the meeting text and the blocks to the other sheets. A failure in one copy never stops the others. */
function CA_push_(src, m, stamp) {
  var P = CA_.PUSH, notes = [];
  var tryIt = function (label, id, fn) {
    if (!id) return;
    try { fn(SpreadsheetApp.openById(id)); notes.push(label + ': done'); }
    catch (e) { notes.push(label + ': not updated (' + e.message + ')'); }
  };
  tryIt('Huddle sheet', P.HUDDLE_ID, function (dst) { CA_pushHuddle_(dst, m); });
  tryIt('Weekly sheet', P.WEEKLY_ID, function (dst) { CA_copyBlocks_(src, P.WEEKLY_BLOCKS, dst, P.WEEKLY_SHEET, stamp); });
  tryIt('Action tracker', P.ACTION_ID, function (dst) { CA_copyBlocks_(src, P.ACTION_BLOCKS, dst, P.ACTION_SHEET, stamp); });
  return notes;
}

/** Bullet list as one cell of text. */
function CA_bulletText_(label, list) {
  return [label].concat(list.map(function (b) { return (b.sub ? '    - ' : '\u2022 ') + b.t; })).join('\n');
}

/** Huddle agenda: finds each agenda row by its text and writes the matching bullets into that row's notes cell. */
function CA_pushHuddle_(dst, m) {
  var P = CA_.PUSH;
  var sh = P.HUDDLE_SHEET ? dst.getSheetByName(P.HUDDLE_SHEET) : dst.getSheets()[0];
  if (!sh) throw new Error('tab ' + P.HUDDLE_SHEET + ' not found');
  var v = sh.getDataRange().getDisplayValues();
  var norm = function (x) { return String(x == null ? '' : x).replace(/\s+/g, ' ').trim().toUpperCase(); };
  var noteCol = -1;
  for (var i = 0; i < Math.min(v.length, 10) && noteCol < 0; i++) {
    for (var j = 0; j < v[i].length; j++) if (P.HUDDLE_NOTES_HEAD.indexOf(norm(v[i][j])) >= 0) { noteCol = j; break; }
  }
  if (noteCol < 0) throw new Error('no Notes column found');
  var texts = { month: CA_bulletText_(m.meeting.labels.month, m.meeting.monthBullets),
                week: CA_bulletText_(m.meeting.labels.week, m.meeting.weekBullets) };
  var done = {};
  P.HUDDLE_ROWS.forEach(function (h) {
    for (var r = 0; r < v.length; r++) {
      if (done[r]) continue;
      var hit = v[r].some(function (x, c) { return c !== noteCol && norm(x).indexOf(h.match) >= 0; });
      if (!hit) continue;
      sh.getRange(r + 1, noteCol + 1).setValue(texts[h.text]).setWrap(true).setVerticalAlignment('top');
      done[r] = true;
      return;
    }
    throw new Error('agenda row "' + h.match + '" not found');
  });
}

/**
 * Copies whole blocks of the Concised Analysis tab (values, number formats, colours, merges) into a tab of another file.
 * A block runs from its title row ("5. Action plan ...") to the row before the next title. The tab is rebuilt each time.
 */
function CA_copyBlocks_(src, prefixes, dst, tabName, stamp) {
  var last = src.getLastRow(), W = 10;
  var colA = src.getRange(1, 1, last, 1).getDisplayValues().map(function (x) { return x[0]; });
  var isTitle = function (t) { return /^\d+\. /.test(t); };
  var spans = [];
  prefixes.forEach(function (p) {
    for (var i = 0; i < last; i++) {
      if (colA[i].indexOf(p + ' ') !== 0) continue;
      var e = i + 1;
      while (e < last && !isTitle(colA[e])) e++;
      spans.push([i + 1, e - i]);   // [first row, row count]
      return;
    }
  });
  var sh = dst.getSheetByName(tabName) || dst.insertSheet(tabName);
  sh.getRange(1, 1, sh.getMaxRows(), sh.getMaxColumns()).breakApart();
  sh.clear();
  sh.setHiddenGridlines(true);
  sh.getRange(1, 1, sh.getMaxRows(), Math.min(sh.getMaxColumns(), W)).setFontFamily('Arial').setFontSize(10).setVerticalAlignment('middle');
  sh.getRange(1, 1).setValue('From Sales Tracker, Concised Analysis   |   Updated ' + stamp + '   |   Rs in Lacs')
    .setFontSize(9).setFontColor(CA_COLORS_.sub);
  var at = 3;
  spans.forEach(function (sp) {
    var a = src.getRange(sp[0], 1, sp[1], W), b = sh.getRange(at, 1, sp[1], W);
    b.setValues(a.getValues());
    b.setNumberFormats(a.getNumberFormats());
    b.setBackgrounds(a.getBackgrounds());
    b.setFontColors(a.getFontColors());
    b.setFontWeights(a.getFontWeights());
    b.setFontSizes(a.getFontSizes());
    b.setHorizontalAlignments(a.getHorizontalAlignments());
    b.setWraps(a.getWraps());
    a.getMergedRanges().forEach(function (g) {
      sh.getRange(at + g.getRow() - sp[0], g.getColumn(), g.getNumRows(), g.getNumColumns()).merge();
    });
    sh.getRange(at, 1, 1, W).setBorder(null, null, true, null, null, null, CA_COLORS_.block, SpreadsheetApp.BorderStyle.SOLID_MEDIUM);
    for (var k = 0; k < sp[1]; k++) sh.setRowHeight(at + k, src.getRowHeight(sp[0] + k));
    at += sp[1];
  });
  for (var c = 1; c <= W; c++) sh.setColumnWidth(c, src.getColumnWidth(c));
}


/**
 * By Whom / By When typed in a zone table: finds the header row holding "By Whom" and reads the rows under it
 * until column A is blank. Returns { ZONE KEY: [byWhom, byWhen] }.
 */
function CA_readManual_(sh) {
  var out = {};
  if (!sh || sh.getLastRow() < 2) return out;
  var v = sh.getRange(1, 1, sh.getLastRow(), Math.max(1, sh.getLastColumn())).getValues();
  var norm = function (x) { return String(x == null ? '' : x).replace(/\s+/g, ' ').trim().toUpperCase(); };
  for (var i = 0; i < v.length; i++) {
    var w = v[i].map(norm).indexOf('BY WHOM'), n = v[i].map(norm).indexOf('BY WHEN');
    if (w < 0) continue;
    var prevWhen = '';   // By When is often one merged cell for all zones: carry it down
    for (var j = i + 1; j < v.length && norm(v[j][0]); j++) {
      var z = norm(v[j][0]), when = n >= 0 && v[j][n] != null && v[j][n] !== '' ? v[j][n] : '';
      if (when === '' && z !== 'PAN INDIA') when = prevWhen; else if (z !== 'PAN INDIA') prevWhen = when;
      out[CA_zk_(z)] = [v[j][w] == null ? '' : v[j][w], when];
    }
    break;
  }
  return out;
}


/* ================================ small helpers ================================ */

/** Zone key: upper case, single spaces, no trailing " RO" (data says NORTH ZONE RO, the target file NORTH ZONE). */
function CA_zk_(z) { return String(z == null ? '' : z).replace(/\s+/g, ' ').trim().toUpperCase().replace(/ RO$/, ''); }
function CA_seed_(z) { var v = CA_.SEED_TARGETS_LACS[z === 'TOTAL' ? z : CA_zk_(z)]; return v == null ? null : v; }

function CA_d_(iso) { var p = String(iso).split('-'); return new Date(Date.UTC(+p[0], +p[1] - 1, +p[2])); }
function CA_iso_(d) { return d.getUTCFullYear() + '-' + ('0' + (d.getUTCMonth() + 1)).slice(-2) + '-' + ('0' + d.getUTCDate()).slice(-2); }
function CA_addDays_(d, n) { return new Date(d.getTime() + n * 86400000); }
var CA_MON_ = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function CA_fmtDay_(iso) { if (!iso) return '-'; var d = CA_d_(iso); return ('0' + d.getUTCDate()).slice(-2) + '-' + CA_MON_[d.getUTCMonth()] + '-' + String(d.getUTCFullYear()).slice(2); }
function CA_fmtRange_(p) {
  var a = CA_d_(p[0]), b = CA_d_(p[1]);
  if (b < a) return 'no days yet';
  return a.getUTCDate() + (a.getUTCMonth() === b.getUTCMonth() ? '' : ' ' + CA_MON_[a.getUTCMonth()]) + ' to ' + b.getUTCDate() + ' ' + CA_MON_[b.getUTCMonth()];
}
function CA_lac_(v) { return (Math.round(v * 100) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function CA_pct1_(v) { return (Math.round(v * 1000) / 10).toFixed(1) + '%'; }
