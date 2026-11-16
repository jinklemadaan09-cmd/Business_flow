/**
 * JOINENGINE.GS
 * -------------
 * Power Query style "Merge Queries", driven by JOIN_CONFIG.
 * Add a join tomorrow = add a row in JOIN_CONFIG with Active = YES.
 *
 * Rules:
 *  - The FIRST active step's Left_Dataset is the base (e.g. PNL).
 *  - The LAST active step's output is the final DASHBOARD_MASTER data,
 *    whatever its Output_Dataset is called.
 *  - No active steps → the base source alone becomes the master.
 *  - Keys are matched after normalising (101307686 = "101307686 ").
 *  - If a right-side column has the same name as a left-side column,
 *    the LEFT value is kept (a discount file can never blank out GR DT etc.).
 *  - Join_Type: LEFT (default) or INNER.
 */

/** The dataset the join chain starts from. */
function getBaseDatasetName_(sources) {
  var steps = getActiveJoinSteps_();
  if (steps.length) return String(steps[0].Left_Dataset).trim();
  return sources[0].Source_Code;
}

/**
 * Resolves a column name for any dataset. Intermediate datasets (J1, J2…)
 * have no COLUMN_CONFIG, so every source's config is searched.
 */
function resolveDatasetColumn_(dataset, name, columnConfigCache) {
  if (columnConfigCache[dataset]) return resolveOutputColumnName_(dataset, name, columnConfigCache);
  // Intermediate dataset (J1, J2…): search the sources in join order — the base dataset (PNL)
  // first — and stop at the first source that knows the name, so GRNO → "GR NO" of PNL and
  // DESTINATION → PNL's DESTINATION, never a look-alike column of a later lookup file.
  var codes = joinOrderCodes_(columnConfigCache);
  var raw = String(name).trim(), target = normName_(name);
  for (var i = 0; i < codes.length; i++) {
    var cf = columnConfigCache[codes[i]] || [];
    for (var a = 0; a < cf.length; a++) if (String(cf[a].Output_Column || '').trim() === raw) return raw;
    for (var b = 0; b < cf.length; b++) {
      if (String(cf[b].Source_Column || '').trim() && normName_(cf[b].Source_Column) === target) return String(cf[b].Output_Column).trim();
    }
    for (var c = 0; c < cf.length; c++) if (normName_(cf[c].Output_Column) === target) return String(cf[c].Output_Column).trim();
  }
  return raw;
}

function joinOrderCodes_(columnConfigCache) {
  var order = [], add = function (c) { c = String(c || '').trim(); if (c && columnConfigCache[c] && order.indexOf(c) < 0) order.push(c); };
  try {
    getActiveJoinSteps_().forEach(function (st) { add(st.Left_Dataset); add(st.Right_Dataset); });
  } catch (e) { /* no JOIN_CONFIG */ }
  Object.keys(columnConfigCache).forEach(add);
  return order;
}

/**
 * JOIN_CONFIG Left_Filter (optional): only left rows meeting it look for a match,
 * e.g.  RATEFOR=CARD RATE   ("=" equals, "<>" not equal, "|" any of, ";" and).
 * Other rows pass through unchanged.
 */
function leftFilterFn_(dataset, spec, columnConfigCache) {
  spec = String(spec || '').trim();
  if (!spec || /^TBD$/i.test(spec)) return null;
  var rules = spec.split(';').map(function (s) { return s.trim(); }).filter(function (s) { return s; }).map(function (s) {
    var m = s.match(/^(.+?)\s*(<>|!=|=)\s*(.*)$/);
    if (!m) throw new Error('JOIN_CONFIG Left_Filter: cannot read "' + s + '"');
    return { col: resolveDatasetColumn_(dataset, m[1].trim(), columnConfigCache), neg: m[2] !== '=',
             vals: m[3].split('|').map(function (v) { return v.trim().toUpperCase().replace(/\s+/g, ' '); }) };
  });
  return function (rec) {
    return rules.every(function (ru) {
      var v = rec[ru.col]; v = (v === null || v === undefined) ? '' : String(v).trim().toUpperCase().replace(/\s+/g, ' ');
      var hit = ru.vals.indexOf(v) >= 0;
      return ru.neg ? !hit : hit;
    });
  };
}

/**
 * Join keys: one column (GRNO) or several joined with "+"
 * (ORIGIN+DELIVERYPOINT). Multi-column keys are compared trimmed,
 * upper-case, single-spaced; a row with any key part blank never matches.
 */
function keyColumns_(dataset, spec, columnConfigCache) {
  return String(spec || '').split('+')
    .map(function (s) { return s.trim().replace(/\?$/, '').trim(); })
    .filter(function (s) { return s; })
    .map(function (s) { return resolveDatasetColumn_(dataset, s, columnConfigCache); });
}

function keyFn_(cols) {
  if (cols.length === 1) {
    var c = cols[0];
    return function (rec) { return normKey_(rec[c]); };
  }
  return function (rec) {
    var parts = [];
    for (var i = 0; i < cols.length; i++) {
      var v = normKey_(rec[cols[i]]).toUpperCase().replace(/\s+/g, ' ');
      if (!v) return '';
      parts.push(v);
    }
    return parts.join('|');
  };
}

/** Right_Key parts ending with "?" are optional: a blank value there means "applies to all". */
function keyOptional_(spec) {
  var parts = String(spec || '').split('+').map(function (s) { return s.trim(); }).filter(function (s) { return s; });
  // Keys of 3+ columns: from the 3rd column on, a blank right-side value always means "applies to all"
  // (e.g. CARD_GOODS, CARD_VIA_BORDER) — with or without "?".
  return parts.map(function (s, i) { return /\?$/.test(s) || (parts.length > 2 && i >= 2); });
}

function normPart_(v) { return normKey_(v).toUpperCase().replace(/\s+/g, ' '); }

/** Right-side key that allows blanks in optional parts. */
function optionalKeyFn_(cols, opt) {
  return function (rec) {
    var parts = [];
    for (var i = 0; i < cols.length; i++) {
      var v = normPart_(rec[cols[i]]);
      if (!v && !opt[i]) return '';
      parts.push(v);
    }
    return parts.join('|');
  };
}

/**
 * Left-side lookup for optional parts — most specific match first:
 * exact value → text after the last "-" ("GENERAL GOODS-FOOTWEAR" → "FOOTWEAR") → blank (general rate).
 */
function optionalLookupFn_(cols, opt, index) {
  return function (rec) {
    var choices = [];
    for (var i = 0; i < cols.length; i++) {
      var v = normPart_(rec[cols[i]]);
      if (!opt[i]) { if (!v) return null; choices.push([[v, 0]]); continue; }
      var c = [];
      if (v) c.push([v, 2]);
      var d = v.lastIndexOf('-');
      if (d >= 0 && d < v.length - 1) { var s = v.slice(d + 1).trim(); if (s && s !== v) c.push([s, 2]); }
      c.push(['', 0]);
      choices.push(c);
    }
    var combos = [[[], 0]];
    choices.forEach(function (c) {
      var next = [];
      combos.forEach(function (cb) { c.forEach(function (x) { next.push([cb[0].concat([x[0]]), cb[1] + x[1]]); }); });
      combos = next;
    });
    combos.sort(function (a, b) { return b[1] - a[1]; });
    for (var k = 0; k < combos.length; k++) {
      var hit = index.get(combos[k][0].join('|'));
      if (hit) return hit;
    }
    return null;
  };
}

function dedupeByKeyFn_(records, keyFn, dateOutputCol, maxOutputCol) {
  var byKey = new Map();
  records.forEach(function (rec) {
    var key = keyFn(rec);
    if (!key) return;
    var existing = byKey.get(key);
    if (existing && !dedupeWins_(rec, existing, dateOutputCol, maxOutputCol)) return;
    byKey.set(key, rec);
  });
  return Array.from(byKey.values());
}

var JOIN_STATS_ = null;   // filled by debugJoin()

/** Runs every active step; returns the final record array. */
function runJoinSteps_(datasets, columnConfigCache, baseName) {
  var steps = getActiveJoinSteps_();
  if (!steps.length) return datasets[baseName] || [];

  var lastOutput = null;

  steps.forEach(function (step) {
    var L = String(step.Left_Dataset || '').trim();
    var R = String(step.Right_Dataset || '').trim();
    var O = String(step.Output_Dataset || '').trim() || ('STEP_' + step.Step_No);

    var left = datasets[L];
    var right = datasets[R];
    if (!left) throw new Error('Join step ' + step.Step_No + ': left dataset "' + L + '" not found (is the source Active?)');
    if (!right) throw new Error('Join step ' + step.Step_No + ': right dataset "' + R + '" not found (is the source Active?)');

    if (/^TBD$/i.test(String(step.Left_Key).trim()) || /^TBD$/i.test(String(step.Right_Key).trim())) {
      throw new Error('Join step ' + step.Step_No + ' is Active but its keys are still TBD.');
    }

    var lkCols = keyColumns_(L, step.Left_Key, columnConfigCache);
    var rkCols = keyColumns_(R, step.Right_Key, columnConfigCache);
    if (lkCols.length !== rkCols.length) {
      throw new Error('Join step ' + step.Step_No + ': Left_Key and Right_Key must have the same number of columns.');
    }
    var rOpt = keyOptional_(step.Right_Key);
    var hasOpt = rOpt.some(function (x) { return x; });
    var lKey = keyFn_(lkCols), rKey = hasOpt ? optionalKeyFn_(rkCols, rOpt) : keyFn_(rkCols);
    var rk = (rkCols.length === 1 && !hasOpt) ? rkCols[0] : null;

    var rightSide = right;
    var rule = String(step.Right_Duplicate_Rule || '').trim().toUpperCase();
    if (rule && rule !== 'NONE') {
      var rd = String(step.Right_Duplicate_Date_Column || '').trim()
        ? resolveDatasetColumn_(R, step.Right_Duplicate_Date_Column, columnConfigCache)
        : null;
      var mc = maxRuleColumn_(step.Right_Duplicate_Rule);           // e.g. MAX:CARD_RATE
      mc = mc ? resolveDatasetColumn_(R, mc, columnConfigCache) : null;
      rightSide = rk ? dedupeRecords_(right.map(function (r) { return Object.assign({}, r); }), rk, rd, mc)
                     : dedupeByKeyFn_(right, rKey, rd, mc);
    }

    var index = new Map();
    rightSide.forEach(function (r) {
      var k = rKey(r);
      if (k) index.set(k, r); // last one wins (records arrive oldest-first)
    });

    var inner = String(step.Join_Type || 'LEFT').trim().toUpperCase() === 'INNER';
    var defaults = joinDefaults_(R, columnConfigCache); // Default_Value for GRs not found on the right
    var out = [];

    var lf = leftFilterFn_(L, step.Left_Filter, columnConfigCache);
    var lookup = hasOpt ? optionalLookupFn_(lkCols, rOpt, index) : function (l) { return index.get(lKey(l)); };
    var st = JOIN_STATS_ ? { step: step.Step_No, L: L, R: R, lk: lkCols, rk: rkCols, left: left.length, right: right.length,
                             rightKeys: index.size, filteredOut: 0, blankKey: 0, matched: 0, sampleL: [], sampleR: [] } : null;
    if (st) { var ri = 0; index.forEach(function (v, k) { if (ri++ < 3) st.sampleR.push(k); }); }
    left.forEach(function (l) {
      if (st) {
        var lk0 = lKey(l);
        if (lf && !lf(l)) st.filteredOut++; else if (!lk0 && !hasOpt) st.blankKey++; else { if (st.sampleL.length < 3) st.sampleL.push(lk0); if (lookup(l)) st.matched++; }
      }
      var match = (lf && !lf(l)) ? null : lookup(l);
      if (!match && inner) return;
      var combined = Object.assign({}, l);
      if (match) {
        Object.keys(match).forEach(function (k) {
          if (rk && k === rk) return;
          if (!Object.prototype.hasOwnProperty.call(combined, k)) combined[k] = match[k];
        });
      }
      Object.keys(defaults).forEach(function (k) {
        var v = combined[k];
        if (v === undefined || v === null || String(v).trim() === '') combined[k] = defaults[k];
      });
      out.push(combined);
    });

    datasets[O] = out;
    lastOutput = O;
    if (st) JOIN_STATS_.push(st);
  });

  return datasets[lastOutput] || [];
}


/**
 * COLUMN_CONFIG Default_Value of a right-side source, typed like the column.
 * Used for left rows with no match (LEFT join) and for blank right values,
 * so a joined column is never blank when a default is configured.
 */
function joinDefaults_(dataset, columnConfigCache) {
  var out = {};
  (columnConfigCache[dataset] || []).forEach(function (c) {
    var d = c.Default_Value;
    if (d === undefined || d === null || String(d).trim() === '') return;
    var name = String(c.Output_Column || '').trim();
    if (!name) return;
    var type = String(c.Data_Type || 'TEXT').trim().toUpperCase();
    try {
      if (type === 'NUMBER') out[name] = roundTo_(parseNumericValue_(d), decimalsFor_(c));
      else if (type === 'DATE') out[name] = toIsoDate_(d, Session.getScriptTimeZone()) || '';
      else out[name] = applyTransform_(castValue_(d, type), c.Transformation);
    } catch (e) { out[name] = d; }
  });
  return out;
}

/** Changes when any joined source's Default_Value changes → master is rebuilt from cache. */
function joinDefaultsSignature_(columnConfigCache) {
  // Also covers the JOIN_CONFIG steps themselves: fixing a step (e.g. its Left_Dataset)
  // makes the next Refresh rebuild the master from the caches, no Excel is re-read.
  var sig = { steps: [] };
  getActiveJoinSteps_().forEach(function (st) {
    var R = String(st.Right_Dataset || '').trim();
    sig[R] = joinDefaults_(R, columnConfigCache);
    sig.steps.push([st.Step_No, st.Left_Dataset, st.Right_Dataset, st.Output_Dataset,
                    st.Left_Key, st.Right_Key, st.Join_Type, st.Right_Duplicate_Rule,
                    st.Left_Filter || '', st.Right_Duplicate_Date_Column || '']
                   .map(function (v) { return String(v == null ? '' : v).trim(); }));
  });
  return JSON.stringify(sig);
}