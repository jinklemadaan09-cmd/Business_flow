/**
 * SUGAM GROUP - Customer Visit Form (Steps 01-05 of the customer journey)
 *
 * One-time setup:
 *   1. script.google.com > New project > paste this whole file > Save.
 *   2. Select function "setup" > Run > allow permissions.
 *   3. Open the response sheet (link in the log), fill tab "Zone_Emails"
 *      (RM email per zone) and tab "Settings" (Costing Head email).
 *   4. Share the form link (in the log) with field representatives.
 *
 * Every submission:
 *   - full answers land in tab "Form Responses 1" (Google default)
 *   - one clean summary row lands in tab "Visit_Summary"
 *   - an email goes to the Costing Head + the Regional Manager of the
 *     customer's zone (cc: field rep), logged in tab "Mail_Log".
 *
 * Lists changed later? Edit tab "Masters" and run "refreshFormOptions".
 */

var FORM_TITLE = 'Sugam Group - Customer Visit Report';
var SHEET_NAME = 'Sugam - Customer Visit Responses';

// Origin booking branches grouped by zone (from LANE_ORIGIN lane master)
var ORIGINS_BY_ZONE = {
  "ANDHRA PRADESH CIRCLE": ["AUTONAGAR (HYD)", "HYDERABAD", "JEEDIMETLA (HYD)", "MEDCHAL", "PATANCHERU (HYD)", "VIJAYAWADA", "VISHAKHAPATNAM"],
  "ASSAM - NE": ["AGARTALA", "AIZWAL", "AMINGAON", "BELTALA (PAMOHI)", "DHARMANAGAR", "DIBRUGARH", "GUWAHATI BOOKING", "IMPHAL", "JAGIROAD", "JORHAT", "NAGAON", "SHILLONG", "SILCHAR", "TINSUKIA", "UDAIPUR (TRIPURA)"],
  "DELHI-NCR": ["ALIGARH", "ALIGARH-SF", "BAWANA", "BHIWADI", "DELHI-ADARSH NAGAR SF", "DELHI-C.CHOWK", "DELHI-DARYAGANJ", "DELHI-GANDHI NAGAR", "DELHI-GANDHI NAGAR(M.M)", "DELHI-K.GANJ", "DELHI-K.GATE OFFICE", "DELHI-K.MARKET", "DELHI-KAROL BAGH", "DELHI-M.NAGAR", "DELHI-MANDOLI-SF", "DELHI-NANGLOI", "DELHI-NARAINA", "DELHI-OKHLA", "DELHI-OKHLA -SF", "DELHI-PATPARGANJ", "DELHI-S.BAZAR", "DELHI-T.P.NAGAR", "DELHI-TIKRI BORDER", "DELHI-V.NAGAR NEW", "FARIDABAD", "GHAZIABAD", "GHAZIABAD-SF", "GURGAON", "KARNAL NEW SF", "KARNAL-SF", "KUNDLI", "KUNDLI-SF", "MANESAR", "MEERUT", "MORADABAD", "NARELA", "NEEMRANA", "NOIDA", "NOIDA-88", "PANIPAT", "ROHTAK", "ROHTAK NEW-SF", "SAHIBABAD", "SAMPLA -SF", "SONIPAT", "SONIPAT NEW SF1", "TRONICA CITY(GZB)", "U.P.BORDER"],
  "GUJARAT": ["AHMEDABAD", "ANKLESHWAR", "BARODA", "BHAV NAGAR", "BHAV NAGAR -SF", "CHHATRAL", "DASHRAT", "GANDHI DHAM", "HALOL", "JETPUR", "NAROL", "ODHAV", "PALANPUR SF", "RAJKOT", "SANAND", "SANTEJ", "SARKHEJ", "SAVARKUNDLA-SF", "SHAPAR", "SURAT CITY", "SURENDER NAGAR", "UMBERGAON", "VAPI", "VATVA"],
  "INDO BORDER CIRCLE": ["JOGBANI", "PALIA", "RAXAUL", "RUPAIDIHA", "SUNAULI"],
  "KARNATAKA CIRCLE": ["BANGALORE", "BANGALORE CITY", "BOMMASANDRA", "HOSKOTE", "HOSUR", "HUBLI", "MALUR-SF", "MYSURE", "TUMKUR"],
  "KERALA CIRCLE": ["COCHIN", "KOTTAYAM"],
  "MADHYA PRADESH": ["INDORE", "INDORE BURHANPUR", "MANDIDEEP", "PITHAM PUR"],
  "MAHARASHTRA": ["AURANGABAD", "BHIWANDI", "DOMBIVILI-EAST", "GOA", "JALGAON-SF", "KOLHAPUR", "MUMBAI", "MUMBAI (ANDHERI)", "NAGPUR", "NASIK", "PALGHAR NEW SF", "PHURSUNGI", "POONA", "PURNA (BHIWANDI)", "RAIPUR", "RANJANGAON", "SANGLI-SF", "SINNAR", "SOLAPUR", "TALOJA", "TARAPUR", "VASAI"],
  "ORISSA CIRCLE": ["BERHAMPUR", "CUTTACK"],
  "PATNA CIRCLE": ["BHITTAMORE", "PATNA"],
  "PUNJAB CIRCLE": ["AMBALA", "AMBALA-SF", "AMBALA-SF1", "AMRITSAR", "BADDI", "BATALA -SF", "CHANDIGARH", "DINANAGAR", "GORAYA", "JAGADHRI", "JAGADHRI-NEW SF", "JALANDHAR", "JAMMU", "KALA AMB-NEW SF", "LUDHIANA T.P.NAGAR", "LUDHIANA TP NAGAR - SF", "LUDHIANA-SF", "PHAGWARA", "UNA"],
  "RAJASTHAN": ["BALOTRA NEW", "BEAWAR", "BHILWARA", "JAIPUR", "JAIPUR TRANSPORT NAGAR NEW-SF", "JAIPUR-SF", "JODHPUR", "PALI NEW SF", "UDAIPUR"],
  "TAMIL NADU CIRCLE": ["B.KOMARAPALAYAM", "CHENNIMELAI", "COIMBATORE", "ERODE", "KARUR NEW SF", "MADRAS", "MADURAI", "PUDUCHERRY", "SRICITY", "TIRUPUR"],
  "UTTAR PRADESH": ["AGRA", "AGRA SF", "BARABANKI", "BARHNI", "GORAKPUR", "GWALIOR", "JALALPUR", "KANPUR", "LUCKNOW", "PRAYAGRAJ", "SHIKOHABAD", "TANDA", "VARANASI"],
  "UTTRAKHAND CIRCLE": ["DEHRADUN", "HARIDWAR", "KASSIPUR", "ROORKEE", "RUDRAPUR", "SAHARANPUR", "SELAQUI", "SITARGANJ"],
  "WEST BENGAL": ["COOCH BEHAR", "COSSIPORE", "DANKUNI", "HOWRAH-SF", "JAIGAON", "KOLKATA", "PETRAPOLE", "RANGPOO", "SILIGURI"],
};

// Destination regions (from LANE_DEST, Broader Lane L3)
var DEST_REGIONS = ['ANDHRA PRADESH CIRCLE', 'BANGLADESH', 'BHUTAN', 'DELHI-NCR', 'GUJARAT', 'GUWAHATI',
  'INDO NEPAL BORDER', 'INSIDE NEPAL', 'JHARKHAND CIRCLE', 'KARNATAKA CIRCLE', 'KERALA CIRCLE', 'LOWER ASSAM',
  'MADHYA PRADESH', 'MAHARASHTRA', 'ORISSA CIRCLE', 'PATNA CIRCLE', 'PUNJAB CIRCLE', 'RAJASTHAN',
  'TAMIL NADU CIRCLE', 'TRIPURA', 'UPPER ASSAM', 'UTTAR PRADESH', 'UTTRAKHAND CIRCLE', 'WEST BENGAL'];

var Q = {
  REP_NAME: 'Field representative name',
  REP_EMAIL: 'Field representative email',
  VISIT_DATE: 'Visit date',
  CUSTOMER: 'Customer / company name',
  ZONE: 'Customer zone (decides which Regional Manager gets the mail)',
  CITY: 'Customer city / location',
  CONTACT: 'Contact person name & designation',
  PHONE: 'Contact mobile number',
  CUST_EMAIL: 'Customer email',
  DECISION: 'Decision makers (name / role)',
  BUSINESS: 'Business model / industry',
  CURRENT_TPT: 'Current transport set-up (current transporter, mode)',
  PAIN: 'Pain points with current set-up',
  EXPECT: 'Service expectations (TAT, pickup, POD, tracking etc.)',
  M_VALUE: 'Current monthly freight spend (Rs)',
  M_VOLUME: 'Current monthly volume (MT)',
  M_SHIP: 'Shipments / dockets per month',
  FREQ: 'Dispatch frequency',
  SEASON: 'Seasonality (peak / lean months)',
  POT_VALUE: 'Potential monthly business with Sugam (Rs)',
  POT_VOLUME: 'Potential monthly volume with Sugam (MT)',
  COMMODITY: 'Commodity / material description',
  MAT_TYPE: 'Material category',
  LOAD: 'Load type',
  PKG_WT: 'Average weight per package (kg)',
  DIMS: 'Typical package dimensions (L x W x H)',
  PACKING: 'Packing type',
  HANDLING: 'Special handling needs',
  RISK: 'Special risks / restrictions (hazardous, fragile, high value, permits)',
  ORIGIN_ZONES: 'Origin zones (where goods will be booked)',
  ORIGIN_PREFIX: 'Origin branches - ',
  DEST_REGIONS: 'Destination regions',
  DEST_CITIES: 'Key destination cities (comma separated)',
  LANE_DETAIL: 'Lane-wise details (Origin > Destination > MT per month > frequency)',
  COVERAGE: 'Branch coverage & feasibility',
  RATE_BASIS: 'Rate basis',
  CUR_RATE: 'Customer current rate (Rs)',
  EXP_RATE: 'Rate expected by customer (Rs)',
  IND_RATE: 'Indicative rate discussed by us (Rs)',
  CHARGES: 'Other charges discussed',
  CREDIT: 'Credit period required',
  REMARKS: 'Remarks / next steps',
  FOLLOWUP: 'Next follow-up date'
};

function setup() {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty('FORM_ID')) {
    throw new Error('Setup already done. Form: ' + FormApp.openById(props.getProperty('FORM_ID')).getEditUrl());
  }
  var form = FormApp.create(FORM_TITLE)
    .setDescription('Fill after every customer visit. Covers Steps 01-05 of the Sugam customer journey: ' +
      'Visit, Monthly Business Potential, Material, Origin & Destination Mapping, Indicative Rate. ' +
      'On submit, the Costing Head and the zone Regional Manager get an email.')
    .setProgressBar(true)
    .setConfirmationMessage('Thank you. Costing Head and Regional Manager have been informed.');
  var zones = Object.keys(ORIGINS_BY_ZONE);

  // STEP 01
  form.addSectionHeaderItem().setTitle('STEP 01 - Customer Visit');
  form.addTextItem().setTitle(Q.REP_NAME).setRequired(true);
  form.addTextItem().setTitle(Q.REP_EMAIL).setRequired(true)
    .setValidation(FormApp.createTextValidation().requireTextIsEmail().build());
  form.addDateItem().setTitle(Q.VISIT_DATE).setRequired(true);
  form.addTextItem().setTitle(Q.CUSTOMER).setRequired(true);
  form.addListItem().setTitle(Q.ZONE).setChoiceValues(zones).setRequired(true);
  form.addTextItem().setTitle(Q.CITY).setRequired(true);
  form.addTextItem().setTitle(Q.CONTACT).setRequired(true);
  form.addTextItem().setTitle(Q.PHONE).setRequired(true)
    .setValidation(FormApp.createTextValidation().requireTextMatchesPattern('^[0-9+ -]{10,15}$')
      .setHelpText('Enter a valid mobile number').build());
  form.addTextItem().setTitle(Q.CUST_EMAIL);
  form.addTextItem().setTitle(Q.DECISION);
  form.addTextItem().setTitle(Q.BUSINESS);
  form.addParagraphTextItem().setTitle(Q.CURRENT_TPT);
  form.addParagraphTextItem().setTitle(Q.PAIN);
  form.addParagraphTextItem().setTitle(Q.EXPECT);

  // STEP 02
  form.addPageBreakItem().setTitle('STEP 02 - Monthly Business Potential');
  var num = FormApp.createTextValidation().requireNumber().setHelpText('Numbers only').build();
  form.addTextItem().setTitle(Q.M_VALUE).setRequired(true).setValidation(num);
  form.addTextItem().setTitle(Q.M_VOLUME).setRequired(true).setValidation(num);
  form.addTextItem().setTitle(Q.M_SHIP).setValidation(num);
  form.addMultipleChoiceItem().setTitle(Q.FREQ).setRequired(true)
    .setChoiceValues(['Daily', '2-3 times a week', 'Weekly', 'Fortnightly', 'Monthly']).showOtherOption(true);
  form.addTextItem().setTitle(Q.SEASON);
  form.addTextItem().setTitle(Q.POT_VALUE).setRequired(true).setValidation(num);
  form.addTextItem().setTitle(Q.POT_VOLUME).setValidation(num);

  // STEP 03
  form.addPageBreakItem().setTitle('STEP 03 - Material Understanding');
  form.addTextItem().setTitle(Q.COMMODITY).setRequired(true);
  form.addCheckboxItem().setTitle(Q.MAT_TYPE).setRequired(true)
    .setChoiceValues(['FMCG', 'Textiles / Garments', 'Pharma', 'Electronics', 'Auto parts', 'Machinery / Spares',
      'Chemicals', 'Hardware / Building material', 'Paper / Printing', 'Plastic / Polymers', 'Food grains / Agro'])
    .showOtherOption(true);
  form.addMultipleChoiceItem().setTitle(Q.LOAD).setRequired(true)
    .setChoiceValues(['Part load (LTL)', 'Full truck load (FTL)', 'Both']);
  form.addTextItem().setTitle(Q.PKG_WT).setValidation(num);
  form.addTextItem().setTitle(Q.DIMS);
  form.addCheckboxItem().setTitle(Q.PACKING)
    .setChoiceValues(['Carton', 'Bags / Bora', 'Bundles', 'Drums', 'Wooden crate', 'Pallet', 'Loose'])
    .showOtherOption(true);
  form.addParagraphTextItem().setTitle(Q.HANDLING);
  form.addParagraphTextItem().setTitle(Q.RISK);

  // STEP 04
  form.addPageBreakItem().setTitle('STEP 04 - Origin & Destination Mapping')
    .setHelpText('Tick all zones where goods will be booked, then tick the Sugam branches under those zones. ' +
      'Multiple selections allowed everywhere.');
  form.addCheckboxItem().setTitle(Q.ORIGIN_ZONES).setChoiceValues(zones).setRequired(true);
  zones.forEach(function (z) {
    form.addCheckboxItem().setTitle(Q.ORIGIN_PREFIX + z).setChoiceValues(ORIGINS_BY_ZONE[z]).showOtherOption(true)
      .setHelpText('Only if ' + z + ' is ticked above');
  });
  form.addCheckboxItem().setTitle(Q.DEST_REGIONS).setChoiceValues(DEST_REGIONS).showOtherOption(true).setRequired(true);
  form.addParagraphTextItem().setTitle(Q.DEST_CITIES).setRequired(true);
  form.addParagraphTextItem().setTitle(Q.LANE_DETAIL)
    .setHelpText('One lane per line, e.g. DELHI-DARYAGANJ > KATHMANDU > 20 MT > weekly');
  form.addMultipleChoiceItem().setTitle(Q.COVERAGE).setRequired(true)
    .setChoiceValues(['All lanes covered by Sugam branches', 'Partly covered', 'Not covered / needs new arrangement']);

  // STEP 05
  form.addPageBreakItem().setTitle('STEP 05 - Indicative Rate Discussion')
    .setHelpText('Indicative only. Final quotation goes after HO costing & approval.');
  form.addMultipleChoiceItem().setTitle(Q.RATE_BASIS).setRequired(true)
    .setChoiceValues(['Per kg', 'Per package', 'Per vehicle (FTL)']).showOtherOption(true);
  form.addTextItem().setTitle(Q.CUR_RATE);
  form.addTextItem().setTitle(Q.EXP_RATE).setRequired(true);
  form.addTextItem().setTitle(Q.IND_RATE);
  form.addCheckboxItem().setTitle(Q.CHARGES)
    .setChoiceValues(['Fuel surcharge', 'FOV / Insurance', 'FOD', 'Docket charge', 'ODA', 'Handling', 'Door delivery'])
    .showOtherOption(true);
  form.addMultipleChoiceItem().setTitle(Q.CREDIT).setRequired(true)
    .setChoiceValues(['Advance / To pay', '15 days', '30 days', '45 days', '60 days', '90 days']).showOtherOption(true);
  form.addParagraphTextItem().setTitle(Q.REMARKS);
  form.addDateItem().setTitle(Q.FOLLOWUP);

  // Response sheet + helper tabs
  var ss = SpreadsheetApp.create(SHEET_NAME);
  form.setDestination(FormApp.DestinationType.SPREADSHEET, ss.getId());
  buildTabs_(ss, zones);

  props.setProperty('FORM_ID', form.getId());
  props.setProperty('SHEET_ID', ss.getId());

  ScriptApp.newTrigger('onVisitSubmit').forForm(form).onFormSubmit().create();

  Logger.log('FORM LINK (share with field reps): ' + form.getPublishedUrl());
  Logger.log('FORM EDIT LINK: ' + form.getEditUrl());
  Logger.log('RESPONSE SHEET: ' + ss.getUrl());
}

function buildTabs_(ss, zones) {
  var bold = function (r) { r.setFontWeight('bold').setBackground('#1f3864').setFontColor('#ffffff'); };

  var ze = ss.insertSheet('Zone_Emails');
  ze.getRange(1, 1, 1, 4).setValues([['Zone', 'Regional Manager Name', 'RM Email', 'Extra CC (comma separated)']]);
  ze.getRange(2, 1, zones.length, 1).setValues(zones.map(function (z) { return [z]; }));
  bold(ze.getRange(1, 1, 1, 4)); ze.setFrozenRows(1); ze.setColumnWidths(1, 4, 220);

  var st = ss.insertSheet('Settings');
  st.getRange(1, 1, 4, 3).setValues([
    ['Key', 'Value', 'Note'],
    ['COSTING_HEAD_EMAIL', '', 'Gets every visit mail (comma separate if more than one)'],
    ['ALWAYS_CC', '', 'Optional, e.g. sales head'],
    ['CC_FIELD_REP', 'YES', 'YES = field rep gets a copy']]);
  bold(st.getRange(1, 1, 1, 3)); st.setColumnWidths(1, 3, 260);

  var vs = ss.insertSheet('Visit_Summary');
  vs.getRange(1, 1, 1, 18).setValues([['Submitted At', 'Visit Date', 'Field Rep', 'Rep Email', 'Customer', 'Zone',
    'City', 'Contact', 'Phone', 'Commodity', 'Monthly Spend (Rs)', 'Monthly MT', 'Potential (Rs)',
    'Origin Branches', 'Destination Regions', 'Destination Cities', 'Expected Rate', 'Mail Status']]);
  bold(vs.getRange(1, 1, 1, 18)); vs.setFrozenRows(1);

  var ml = ss.insertSheet('Mail_Log');
  ml.getRange(1, 1, 1, 5).setValues([['Time', 'Customer', 'Zone', 'Sent To / CC', 'Status']]);
  bold(ml.getRange(1, 1, 1, 5)); ml.setFrozenRows(1);

  var ms = ss.insertSheet('Masters');
  var rows = [];
  zones.forEach(function (z) { ORIGINS_BY_ZONE[z].forEach(function (o) { rows.push([z, o, '']); }); });
  DEST_REGIONS.forEach(function (d, i) { if (rows[i]) rows[i][2] = d; else rows.push(['', '', d]); });
  ms.getRange(1, 1, 1, 3).setValues([['Origin Zone', 'Origin Branch', 'Destination Region']]);
  ms.getRange(2, 1, rows.length, 3).setValues(rows);
  bold(ms.getRange(1, 1, 1, 3)); ms.setFrozenRows(1);

  var blank = ss.getSheetByName('Sheet1');
  if (blank) ss.deleteSheet(blank);
}

/** Runs on every form submit (installed trigger). */
function onVisitSubmit(e) {
  var ss = SpreadsheetApp.openById(PropertiesService.getScriptProperties().getProperty('SHEET_ID'));
  var a = {}, rows = [], origins = [];
  e.response.getItemResponses().forEach(function (ir) {
    var t = ir.getItem().getTitle(), v = ir.getResponse();
    if (Array.isArray(v)) v = v.join(', ');
    v = String(v);
    a[t] = v;
    if (t.indexOf(Q.ORIGIN_PREFIX) === 0) { if (v) origins.push(v); return; }
    rows.push([t, v]);
  });
  var originText = origins.join(', ');
  // put combined origin branches right after origin zones in the mail
  var oz = rows.map(function (r) { return r[0]; }).indexOf(Q.ORIGIN_ZONES);
  rows.splice(oz + 1, 0, ['Origin branches', originText]);

  var zone = a[Q.ZONE] || '';
  var settings = readSettings_(ss);
  var rm = findZone_(ss, zone);

  var to = [settings.COSTING_HEAD_EMAIL, rm.email].filter(String).join(',');
  var cc = [rm.cc, settings.ALWAYS_CC, (String(settings.CC_FIELD_REP).toUpperCase() === 'YES' ? a[Q.REP_EMAIL] : '')]
    .filter(String).join(',');

  var status;
  if (!to) {
    status = 'NOT SENT - fill COSTING_HEAD_EMAIL in Settings / RM email for ' + zone + ' in Zone_Emails';
  } else {
    var subject = 'New Customer Visit: ' + a[Q.CUSTOMER] + ' | ' + zone + ' | Potential Rs ' + (a[Q.POT_VALUE] || '-') + '/month';
    var html = '<p>Dear ' + (rm.name ? 'Costing Head / ' + esc_(rm.name) : 'Team') + ',</p>' +
      '<p><b>' + esc_(a[Q.REP_NAME]) + '</b> visited <b>' + esc_(a[Q.CUSTOMER]) + '</b> (' + esc_(a[Q.CITY]) + ', zone <b>' +
      esc_(zone) + '</b>). Please review for HO costing &amp; P&amp;L (Step 06).</p>' +
      '<table cellpadding="6" style="border-collapse:collapse;font-family:Arial;font-size:13px">' +
      rows.map(function (r, i) {
        return '<tr style="background:' + (i % 2 ? '#ffffff' : '#f2f5fa') + '"><td style="border:1px solid #d0d7e2;width:280px"><b>' +
          esc_(r[0]) + '</b></td><td style="border:1px solid #d0d7e2">' + esc_(r[1]).replace(/\n/g, '<br>') + '</td></tr>';
      }).join('') + '</table>' +
      '<p>Full data: <a href="' + ss.getUrl() + '">' + SHEET_NAME + '</a></p>';
    try {
      var mail = { to: to, cc: cc, subject: subject, htmlBody: html, name: 'Sugam Customer Visit' };
      if (a[Q.REP_EMAIL]) mail.replyTo = a[Q.REP_EMAIL];
      MailApp.sendEmail(mail);
      status = 'SENT' + (rm.email ? '' : ' (no RM email for ' + zone + ', only Costing Head)');
    } catch (err) {
      status = 'FAILED: ' + err.message;
    }
  }

  ss.getSheetByName('Mail_Log').appendRow([new Date(), a[Q.CUSTOMER], zone, to + (cc ? ' | cc: ' + cc : ''), status]);
  ss.getSheetByName('Visit_Summary').appendRow([e.response.getTimestamp(), a[Q.VISIT_DATE], a[Q.REP_NAME], a[Q.REP_EMAIL],
    a[Q.CUSTOMER], zone, a[Q.CITY], a[Q.CONTACT], a[Q.PHONE], a[Q.COMMODITY], a[Q.M_VALUE], a[Q.M_VOLUME],
    a[Q.POT_VALUE], originText, a[Q.DEST_REGIONS], a[Q.DEST_CITIES], a[Q.EXP_RATE], status]);
}

function readSettings_(ss) {
  var out = {};
  ss.getSheetByName('Settings').getDataRange().getValues().slice(1).forEach(function (r) {
    out[String(r[0]).trim()] = String(r[1]).trim();
  });
  return out;
}

/** Zone names compared without case, extra / non-breaking spaces or dash spacing. */
function zoneKey_(z) { return String(z == null ? '' : z).replace(/[\s\u00a0]+/g, ' ').replace(/\s*-\s*/g, '-').trim().toUpperCase(); }

function findZone_(ss, zone) {
  var data = ss.getSheetByName('Zone_Emails').getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (zoneKey_(data[i][0]) === zoneKey_(zone)) {
      return { name: String(data[i][1]).trim(), email: String(data[i][2]).trim(), cc: String(data[i][3]).trim() };
    }
  }
  return { name: '', email: '', cc: '' };
}

function esc_(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Re-reads tab "Masters" and updates the zone dropdown, origin zones,
 * per-zone origin branch lists and destination regions in the form.
 * New zones get a new origin-branch question; add that zone to Zone_Emails too.
 */
function refreshFormOptions() {
  var props = PropertiesService.getScriptProperties();
  var form = FormApp.openById(props.getProperty('FORM_ID'));
  var ss = SpreadsheetApp.openById(props.getProperty('SHEET_ID'));
  var data = ss.getSheetByName('Masters').getDataRange().getValues().slice(1);
  var byZone = {}, dests = [];
  data.forEach(function (r) {
    var z = String(r[0]).trim(), o = String(r[1]).trim(), d = String(r[2]).trim();
    if (z && o) (byZone[z] = byZone[z] || []).push(o);
    if (d && dests.indexOf(d) < 0) dests.push(d);
  });
  var zones = Object.keys(byZone).sort();
  var items = form.getItems();
  var lastOrigin = null;
  items.forEach(function (it) {
    var t = it.getTitle();
    if (t === Q.ZONE) it.asListItem().setChoiceValues(zones);
    else if (t === Q.ORIGIN_ZONES) { it.asCheckboxItem().setChoiceValues(zones); lastOrigin = lastOrigin || it; }
    else if (t === Q.DEST_REGIONS) it.asCheckboxItem().setChoiceValues(dests);
    else if (t.indexOf(Q.ORIGIN_PREFIX) === 0) {
      var z = t.substring(Q.ORIGIN_PREFIX.length);
      if (byZone[z]) it.asCheckboxItem().setChoiceValues(byZone[z].sort());
      lastOrigin = it;
    }
  });
  zones.forEach(function (z) {
    var exists = items.some(function (it) { return it.getTitle() === Q.ORIGIN_PREFIX + z; });
    if (!exists) {
      var ni = form.addCheckboxItem().setTitle(Q.ORIGIN_PREFIX + z).setChoiceValues(byZone[z].sort())
        .showOtherOption(true).setHelpText('Only if ' + z + ' is ticked above');
      form.moveItem(ni.getIndex(), lastOrigin.getIndex() + 1);
      lastOrigin = ni;
    }
  });
  Logger.log('Form options refreshed: ' + zones.length + ' zones, ' + dests.length + ' destination regions');
}
