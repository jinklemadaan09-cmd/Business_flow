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
  ACTION_PLAN_ROWS: 8,

  PROP_LAST: 'CA_LAST_RUN'
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
  CA_writeTargets_(ss, model);
  CA_render_(ss, model, Utilities.formatDate(new Date(), CA_.TZ, 'dd-MMM-yy HH:mm'));
  props.setProperty(CA_.PROP_LAST, key);
  return 'Updated: data up to ' + CA_fmtDay_(model.dataTo) + '.';
}


/* ================================ data in ================================ */

/** Earliest date any block needs: first day of the previous month, or 5 weeks back. */
function CA_firstDayNeeded_(today) {
  var t = CA_d_(today);
  var a = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() - 1, 1));
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
    rev: col(['TOTAL FREIGHT']), exp: col(['TOTAL EXPENSE', 'TOTAL EXPENSES'])
  };
  var out = [];
  (state.masterParts || []).forEach(function (id) {
    var part = readJsonFile_(id);
    part.rows.forEach(function (r) {
      var d = r[ix.date];
      if (typeof d !== 'string' || d < fromDay) return;
      out.push(CA_rec_(d, r[ix.zone], r[ix.branch], r[ix.cust], r[ix.rev], ix.exp >= 0 ? r[ix.exp] : 0));
    });
  });
  return out;
}

function CA_rec_(day, zone, branch, cust, rev, exp) {
  var s = function (v) { v = String(v == null ? '' : v).replace(/\s+/g, ' ').trim(); return v || 'UNSPECIFIED'; };
  var n = function (v) { v = Number(v); return isFinite(v) ? v : 0; };
  return { d: day.slice(0, 10), z: s(zone), b: s(branch), c: s(cust), rev: n(rev), gp: n(rev) - n(exp) };
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
      var k = keyFn(r), x = o[k] || (o[k] = { rev: 0, gp: 0 });
      x.rev += r.rev; x.gp += r.gp;
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

  /* ---- 5. action plan: where to work (largest Rs gap first) ---- */
  var plan = [];
  var missedZones = {};
  last.concat(stand).forEach(function (r) { if (r.status === 'Missed' || r.status === 'Close') missedZones[r.zone] = true; });
  brDrops.filter(function (x) { return missedZones[x.zone]; }).slice(0, 4).forEach(function (x) {
    plan.push({ zone: x.zone, where: 'Branch: ' + x.name, gap: x.drop, action: 'Recover booking volume; review top customers of the branch' });
  });
  custDrops.slice(0, 4).forEach(function (x) {
    plan.push({ zone: x.zone, where: 'Customer: ' + x.name, gap: x.drop, action: 'Call customer; check rate, service and lost lanes' });
  });
  lowGp.slice(0, 3).forEach(function (x) {
    plan.push({ zone: x.zone, where: 'Customer: ' + x.name + ' (GP ' + CA_pct1_(x.gpPct) + ')', gap: x.gap, action: 'Revise rate or cut cost on this account' });
  });
  plan.sort(function (a, b) { return b.gap - a.gap; });
  plan = plan.slice(0, CA_.ACTION_PLAN_ROWS);

  return {
    today: today, dataTo: dataTo, periods: P, mtdDays: dayN, daysLeft: daysLeft, monthDaysLeft: mDaysLeft,
    zones: zones, targets: tgt, targetTotal: tgtTotal,
    stand: stand, standTotal: standTot, last: last, lastTotal: lastTot, thisWeek: thisW, thisTotal: thisTot,
    points: pts, plan: plan
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
  block('5. Action plan: where to work',
    ['Zone', 'Where', 'Gap', 'Action'],
    m.plan.map(function (x) { return [x.zone, x.where, x.gap, x.action]; }),
    [null, null, LAC, null], { spans: [1, 3, 1, 5], left: [1, 3], empty: 'No gap found' });

  sh.setColumnWidth(1, 190);
  sh.setColumnWidths(2, W - 1, 104);
  sh.setFrozenRows(2);
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


/* ================================ dashboard: Meeting Numbers page ================================ */

/**
 * Zone revenue targets for the dashboard's "Meeting Numbers" page, read from the Sales Tracker
 * Targets tab (the same targets the Concised Analysis tab uses).
 * Per zone: column D "Revenue Target used" when filled (blank zones already split there),
 * else column B, else the starting target in CA_.SEED_TARGETS_LACS. Amounts in Rs Lacs.
 */
function meetingTargetsGet(session) {
  try {
    if (laneSessionUser_(session) === false) return { ok: false, error: 'LOGIN_REQUIRED' };
    var cache = CacheService.getScriptCache(), hit = null;
    try { hit = cache.get('mtg_targets_v1'); } catch (e) { /* ignore */ }
    if (hit) return JSON.parse(hit);
    var out = { ok: true, source: 'Sales Tracker > Targets', zones: {}, total: null };
    Object.keys(CA_.SEED_TARGETS_LACS).forEach(function (k) { if (k !== 'TOTAL') out.zones[k] = CA_.SEED_TARGETS_LACS[k]; });
    out.total = CA_.SEED_TARGETS_LACS.TOTAL;
    try {
      var sh = SpreadsheetApp.openById(CA_.SPREADSHEET_ID).getSheetByName(CA_.TARGETS_SHEET);
      if (sh && sh.getLastRow() > 1) {
        var w = Math.min(4, sh.getLastColumn());
        sh.getRange(2, 1, sh.getLastRow() - 1, w).getValues().forEach(function (r) {
          var z = String(r[0] || '').replace(/\s+/g, ' ').trim().toUpperCase();
          if (!z) return;
          var num = function (v) { return v === '' || v == null || !isFinite(Number(v)) ? null : Number(v); };
          var v = num(r[3]); if (v == null) v = num(r[1]);
          if (v == null) return;
          if (z === 'TOTAL') out.total = v; else out.zones[CA_zk_(z)] = v;
        });
      }
    } catch (e) {
      out.source = 'Built-in starting targets (Targets tab not readable: ' + String(e && e.message || e) + ')';
    }
    try { cache.put('mtg_targets_v1', JSON.stringify(out), 600); } catch (e) { /* ignore */ }
    return out;
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
}
