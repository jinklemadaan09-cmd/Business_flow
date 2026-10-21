/**
 * SUGAM GROUP - Customer Visit web app (custom HTML look for the same flow)
 *
 * Add this file + Index.html to the SAME Apps Script project as
 * Sugam_Customer_Visit_Form.gs (setup must already have been run there).
 * Then: Deploy > New deployment > type "Web app" > Execute as: Me >
 * Who has access: Anyone > Deploy > copy the Web app URL for field reps.
 *
 * Each submission:
 *   - tab "Web_Responses": one row per visit, every field
 *   - tab "Visit_Lanes":   one row per origin > destination lane
 *   - tab "Visit_Summary" + "Mail_Log": same as the Google Form
 *   - email to Costing Head + zone Regional Manager (cc field rep)
 */

// Destination cities grouped by region (from LANE_DEST, Broader Lane L3)
var DEST_CITIES_BY_REGION = {
  "ANDHRA PRADESH CIRCLE": ["ANANT PUR", "AUTONAGAR (HYD)", "CHITTOOR", "GUNTUR", "HINDUPUR", "HYDERABAD", "JEEDIMETLA (HYD)", "KAKINADA", "KARIMNAGAR", "KHAMMAM", "KONDAPALLY", "KURNOOL", "LALAGUDA", "MAHABOOB NAGAR", "MEDAK", "MEDCHAL", "NALGONDA", "PATANCHERU (HYD)", "RANGAREDDY", "SANGAREDDY", "SECUNDRABAD", "SIDDIPET", "SRIKAKULAM", "TIRUPATI", "VIJAYAWADA", "VISHAKHAPATNAM", "WARANGAL"],
  "BANGLADESH": ["BENAPOLE", "PETRAPOLE"],
  "BHUTAN": ["JAIGAON"],
  "DELHI-NCR": ["ALIGARH-SF", "ALIPUR", "AMBALA CANT", "BAHADURGARH NEW (CLOSED)", "BAWAL", "BAWANA", "BHIWADI", "BILASPUR-HR", "DELHI", "DELHI-ADARSH NAGAR SF", "DELHI-BHAJANPURA SF", "DELHI-C.CHOWK", "DELHI-DARYAGANJ", "DELHI-GANDHI NAGAR", "DELHI-K.GATE OFFICE", "DELHI-KAROL BAGH", "DELHI-MUNDKA", "DELHI-NANGLOI", "DELHI-NARAINA", "DELHI-OKHLA", "DELHI-S.BAZAR", "DELHI-T.P.NAGAR", "DELHI-TIKRI BORDER", "DELHI-V.NAGAR", "FARIDABAD", "FARRUKH NAGAR", "GHAZIABAD", "GURGAON", "HAPUR", "HISAR", "IGI AIRPORT (DELHI)", "JHAJJAR", "KAITHAL", "KARNAL", "KUNDLI", "MANESAR", "MEERUT", "MORADABAD", "NEEMRANA", "NOIDA", "NOIDA-88", "PANIPAT", "RAILWAY STATION (BADLI)", "ROHTAK", "ROHTAK (CLOSED)", "SAHIBABAD", "SIKANDRABAD", "SONEPAT", "SONIPAT", "SURAJPUR (G.NOIDA)", "U.P.BORDER"],
  "GUJARAT": ["AHMEDABAD", "ANJAR", "ANKLESHWAR", "ASLALI", "BARODA", "BHARUCH", "BHAV NAGAR", "CHATRAL", "CHHATRAL", "DAHEJ", "DAHEJ (GJ)", "DHANERA", "GANDHI DHAM", "HALOL", "JAMNAGAR", "JETALPUR", "KOSAMBA", "KUTCH", "MUNDRA", "MUNDRA PORT", "ODHAV", "RAJKOT", "SACHIN", "SANAND", "SARKHEJ", "SURAT", "SURAT CITY", "SURENDER NAGAR", "UMBERGAON", "VALSAD", "VAPI", "VATVA"],
  "GUWAHATI": ["ABHOYNAGAR (AGT)", "AMINGAON (GHT)", "BELTALA (PAMOHI)", "BIJOYNAGAR", "BILASIPARA", "BYRNIHAT (GHT)", "CHANGSARI", "DARRANG", "DHEKIAJULI", "DISPUR", "DOIMUKH", "GOALPARA (GHT)", "GUWAHATI", "GUWAHATI CITY", "GUWAHATI G P O", "HOJAI (GHT)", "KAMRUP", "KHANAPARA (GHT)", "KHARUPETIA", "LUMDING", "PALASHBARI", "PANDU", "PAPUM PARE", "REHABARI", "RIBHOI", "SONAPUR (GHT)", "TANGLA (GHT)", "ULUBARI"],
  "INDO NEPAL BORDER": ["AMLEKHGANJ", "BAGMATI ZONE", "BANDIPUR", "BANKEY", "BANSGADHI", "BARA", "BARDGHAT", "BARDHIAH", "BARDIVASH", "BARDIYA", "BARGACHHI", "BARHNI", "BHAIRAWA-CUSTOM", "BHITTAMORE", "BIRATNAGAR", "BIRATNAGAR TO", "BIRGUNJ TO", "BUTWAL", "CHANDRAUTA", "CHHATAPIPRA", "CHORNI", "DAMAK", "DANG", "DANG (BARHNI)", "DHALKEBAR", "DHALKEWARE", "DHANGADHI", "DHANGURHI-BHANSAR", "DHANGURI", "DHANUSHA", "DHARAN", "DUHABI", "GALESHWAR", "GARUDA", "GAUSHALA", "GHORAHI", "GULMI", "HARIYON", "ITAHARA", "ITAHARI", "JALESHWAR (NP)", "JANAKPUR", "JANAKPUR DHAM", "JEETPUR", "JOGBANI", "KAILALI", "KALANKI", "KANCHANPUR", "KAPILVASTU", "KAPILVASTU (BARHNI)", "KHANAR", "KOHALPUR", "KRISHANA NAGAR", "LAHAN", "LIPANIMAL", "LUMBINI", "MAHARAJGANJ", "MAHENDRANAGAR", "MAHOTTARI", "MALANGWA", "MORANG", "MUSTANG (N)", "NAWALPARASI", "NAWALPUR", "NAXAL", "NEPALGANJ", "PADSARI", "PALIA", "PANAUTI", "PANCHKHAL", "PARASI", "PARSA", "POKHARIA", "POKHRA TO", "RAHUGHAT", "RAMGADHWA", "RAMNAGAR-NEPAL", "RAMPUR-TOKNI", "RAUTAHAT", "RAXAUL", "ROLPA (NEPAL)", "RUPAIDIHA", "RUPANDEHI", "SAPTARI", "SARLAHI", "SIDDHARTHA NAGAR (NEPAL)", "SIMRA", "SIRHA", "SUNAULI", "SUNSARI", "SURKHET", "TILOTTAMA", "TRIPURESHWAR", "UDAYAPUR (NEPAL)"],
  "INSIDE NEPAL": ["ADARSH NAGAR", "BAGLUNG", "BALAJU", "BANEPA", "BANKA", "BARAHATHAWA", "BASANTAPUR", "BHAIRAHAWA", "BHAKTAPUR", "BHARATPUR (NP)", "BHATBHATENI", "BIRENDRA NAGAR", "BIRGUNJ", "CHABAHIL", "CHITWAN", "CHITWOR-NP", "DAMAULI", "DAMKAULI", "DHADING (NP)", "DUMKIBAS", "GAINDAKOT", "GAIRIDHARA", "GANDAKI", "GAURADAHA", "GHANTAGHAR", "GORKHA", "GULARIYA", "HETAUDA", "HETAUDA TO", "JALESHWAR", "JANAKPURDHAM", "KAKARBHITTA", "KAMALADI", "KASKI", "KATHMANDU", "KATHMANDU TO", "KAVRE", "KHANDBARI", "KOTESHWOR", "KOTHIWAHA", "KURINTAR", "LALITPUR", "MADI", "MAKWANPUR", "MECHI", "MIRCHAIYA", "MUKUNDAPUR", "NARAINGHAT", "NARAINGHAT TO", "NARAYAN GARH", "NARAYANI", "NUWAKOT", "PALPA", "PARWANIPUR", "POKHRA", "SAMAKHUSI", "SHREEPUR", "SIMARA", "SINDHUPAL CHOWK", "SIRAHA MIRCHAYA", "SYANGJA", "TANAHUN", "TAPLEJUNG", "THAPATHALI-NP"],
  "JHARKHAND CIRCLE": ["BOKARO", "CHATRA", "DALTANGANJ", "DEOGARH", "DHANBAD", "GARHWA", "GIRIDIH", "GODDA", "KODERMA", "RANCHI", "TATANAGAR"],
  "KARNATAKA CIRCLE": ["BAGALKOT", "BANGALORE", "BANGALORE CITY", "BELGAUM", "BELLARY", "BOMMASANDRA", "BOMMASANDRA BNG", "DAVANGIRI", "DHARWAD", "GULBARGA", "HAROHALLI", "HASSAN", "HOSKOTE", "HOSUR", "HUBLI", "KOPAL", "MALUR", "MANGALORE", "MANGLORE", "MYSURE", "NELAMANGALA", "RAICHUR", "TUMKUR"],
  "KERALA CIRCLE": ["ALPHOUZA (KERALA)", "CHALAKUDI", "COCHIN", "ERNAKULAM", "KANNUR", "KASARAGOD", "KOCHI", "KOLLAM", "KOTTAYAM", "KOZHIKODE", "PALAKKAD", "THIRUVANANTHAPURAM"],
  "LOWER ASSAM": ["BARPETA", "BONGAIGAON", "CHIRANG", "DHUBRI", "GOALPARA", "KOKRAJAR", "NALBARI", "SORBHOG"],
  "MADHYA PRADESH": ["BHOPAL", "CHHINDWARA", "DEWAS", "HOSHANGABAD", "INDORE", "ITARSI", "JABALPUR", "KATNI", "KHANDWA", "MALANPUR", "MANDIDEEP", "MORENA", "PALDA", "PATHARI", "PITHAM PUR", "PITHAMPUR", "RAISEN", "REWA", "SAGAR", "SATNA", "SIDHI", "UJJAIN"],
  "MAHARASHTRA": ["AHMEDNAGAR", "AMBERNATH", "AMBERNATH (CLOSED)", "AMRAVATI", "AURANGABAD", "BEED", "BHIWANDI", "BHUSAWAL", "BOREGAON", "CHANDRAPUR", "DOLVI", "GOA", "JALGAON OFFICE", "KALAMBOLI", "KANDIVALI", "KIRANDUL", "KOLHAPUR", "LATUR", "MUMBAI", "MUMBAI (ANDHERI)", "NAGPUR", "NASIK", "NAVI MUMBAI", "NHAVA SEVA", "NHAVASHEVA", "PALGHAR NEW SF", "PANVEL", "PATALGANGA", "POONA", "PUNE", "PUNE AIRPORT", "PURNA (BHIWANDI)", "RAIPUR", "RANJANGAON", "RANJIT NAGAR", "SANGLI", "SOLAPUR", "TALOJA", "TARAPUR", "URAN", "VASAI", "WAI", "YAVATMAL"],
  "ORISSA CIRCLE": ["ANGUL", "ATHAGARH", "BALASORE", "BALUGAON", "BARBIL", "BERHAMPUR", "BHADRAK", "BHILAI", "BHUBNESHWAR", "BILASPUR", "BONDAMUNDA", "CUTTACK", "DHENKANAL", "JAGATSINGHPUR", "JHARSAGUDA", "KEONJHAR", "KORAPUT", "MAYURBHANJ", "RAIGARH-CG", "RAMGARH", "RAYAGADA", "ROURKELA", "SAMBALPUR", "SUBARNAPUR"],
  "PATNA CIRCLE": ["ARARIA", "ARRAH", "ARRAH-SF", "AURANGABAD (BIHAR)", "BARAUNI", "BEGUSARAI", "BETTIAH", "BHAGAL PUR", "CHAMPARAN", "CHAPRA", "DANAPUR", "DARBHANGA", "EAST CHAMPARAN", "FORBESGANJ", "GARHARA", "GAYA", "GOPAL GANJ", "HAJIPUR", "JAMSHEDPUR (JK)", "JAMUI", "JEHANABAD", "KATIHAR", "KHAGARIA", "KISHANGANJ", "MADHUBANI", "MOTIHARI", "MUNGER", "MUZAFFARPUR", "NALANDA", "NAWADA", "PAKRIDAYAL", "PATNA", "PATNA CITY", "PURNEA", "RAMGARHWA", "ROHTAS", "SAHARSA", "SAMASTIPUR", "SARAN", "SASARAM", "SITAMARHI", "SIWAN", "SUGAULI", "VAISHALI"],
  "PUNJAB CIRCLE": ["AMBALA", "AMRITSAR", "ANANDPUR", "BADDI", "BATHINDA", "CHANDIGARH", "DERA BASI", "JALANDHAR", "JAMMU", "JAMMU-SF", "KAPURTHALA", "LALRU", "LEH LADAKH", "LUDHIANA", "LUDHIANA T.P.NAGAR", "MANALI", "MOGA", "MOHALI", "PANCHKULA", "PARWANOO", "PATIALA", "UDHAM PUR", "ZIRAKPUR"],
  "RAJASTHAN": ["AJMER", "ALWAR", "BARMER", "BEAWAR", "BEHROR", "JAIPUR", "JAISALMER", "JODHPUR", "KAMAN", "KOTA", "MARWAR MUNDWA", "NEWAI", "UDAIPUR"],
  "TAMIL NADU CIRCLE": ["AMBATTUR", "ARAKKONAM", "CHENNAI", "CHENNAI-SF", "COIMBATORE", "CUDDALORE", "DINDIGUL", "ERODE", "GUDUVANCHERI", "KANCHIPURAM", "KARUR NEW SF", "KRISHNAGIRI", "MADHAVARAM", "MADRAS", "MADURAI", "MANCHERIAL", "ORAGADAM", "PUDUCHERRY", "RADHAPURAM", "SRICITY", "SRIPERUMBUDUR", "THOOTHUKUDI", "TIRUPUR", "TUTICORAIN"],
  "TRIPURA": ["AGARTALA", "AGARTALA BAZAR", "AGARTALA TOWN", "AMBASSA (AGT)", "BELONIA (TRIPURA)", "DHARMANAGAR", "KAILASAHAR (DRMNGR)", "KAKRABAN (AGT)", "KAMALPUR (AGT)", "KHOWAI (AGT)", "KUMARGHAT", "LEMBUCHERRA", "MANU (AGT)", "MELAGHAR (AGT)", "SANTIBAZAR", "SIDHAI MOHANPUR (AGT)", "TELIAMURA (AGT)", "UDAIPUR (TRIPURA)"],
  "UPPER ASSAM": ["ABHAYAPURI", "AIZWAL", "AIZWAL CITY", "AMONI", "AMUGURI (JRT)", "BADARPUR", "BAIHATA CHARIALI", "BANDERDEWA", "BHALUKPONG", "BHOLAGANJ BAZAR (SLLG)", "BINOVANAGAR", "BISHNUPUR (SLLG)", "BOKAJAN", "BOKO", "CACHAR", "CHAMPHAI (AZL)", "CHANGLANG", "CHHAYGAON", "CHUMUKDIMA (DMP)", "CHURACHANDPUR", "DAYAPUR (CRPF)", "DERGAON", "DHEMAJI", "DIBRUGARH", "DIMAPUR", "DIMAPUR TOWN AREA (DMP)", "DIPHU", "DIRANG", "DULIAJAN", "DURTLANG (AZL)", "GOHPUR", "GOLAGHAT (JRT)", "HAFLONG", "HAILA KANDI", "IEWDUH (SLLG)", "IMPHAL", "ITA NAGAR", "JAGIROAD", "JAIRAMPUR", "JORABAT", "JORHAT", "KARIMGANJ", "KHATKHATI (GHT)", "KHAWZAWL (AZL)", "KHAYERPUR", "KIPHIRE", "KOHIMA", "KOLASIB (AZL)", "LABAN (SLLG)", "LADRYMBAI", "LAITKOR (SLLG)", "LAITRYNGEW (SLLG)", "LAITUMKHRAH (SLLG)", "LAWNGTLAI (AZL)", "LUNGLEI (AZL)", "MAMIT (AZL)", "MASIMPUR", "MAWSMAI", "MIRZA", "MISAMARI", "MISSAMARI (TZP)", "MIZORAM UNIVERSITY (AZL)", "MOKOKCHUNG", "MORANHAT (JRT)", "MORIGAON", "NAGAON", "NAHARLAGUN", "NALTOLI", "NAMRUP (JRT)", "NAMSAI", "NARANGI SATGAON", "NONGPOH (SLLG)", "NORTH LAKIMPUR", "NUMALIGARH", "OAKLAND (SLLG)", "PANIKHAITI", "PASIGHAT", "RANGIA", "SAITUAL (AZL)", "SELING (AZL)", "SERCHHIP (AZL)", "SHILLONG", "SHIV SAGAR", "SILAPATHAR", "SILCHAR", "SONITPUR", "TEZPUR", "TEZU", "TINSUKIA", "TURA", "UMSNING (SLLG)", "UPPER SHILLONG", "YUPIA"],
  "UTTAR PRADESH": ["AGRA", "AYODHYA", "AZAMGARH", "BAHRAICH", "BANDA", "BARABANKI", "BAREILLY (CLOSED)", "BULANDSHAHR", "DEORIA", "ETAH", "FAIZABAD", "FARUKABAD", "GONDA", "GORAKPUR", "GUNJDUNDWARA", "GWALIOR", "HARDOI", "HATHRAS", "JAUNPUR", "KANPUR", "KUSHINAGAR", "LONI", "LUCKNOW", "MIRZA PUR", "MUZAFFARNAGAR (CLOSED)", "NAUTANWA", "NICHLAUL", "PITHORAGARH", "PRATAPGARH", "PRAYAGRAJ", "RAIBARELLY", "SHAHJAHANPUR", "SONBHADRA", "VARANASI"],
  "UTTRAKHAND CIRCLE": ["ALMORA", "DEHRADUN", "HARIDWAR", "KASHIPUR", "KASSIPUR", "KICHHA", "PANTNAGAR", "RISHIKESH", "ROORKEE", "RUDRAPUR", "SAHARANPUR", "SELAQUI", "SITARGANJ"],
  "WEST BENGAL": ["AGARPARA", "ALAMPUR -SA", "ALIPURDUAR", "AMBIKAPUR", "ASANSOL", "BAGDOGRA", "BAJO", "BALUWATAR", "BANGAON", "BANKURA", "BARASAT", "BARDHAMAN", "BASIRHAT", "BHATPARA", "BHUMTHANG", "BIRBHUM", "BIRTAMODE", "BISHNUPUR", "BONHOOGHLY", "BURDWAN", "CHANGZAMTOG", "CHITTARANJAN", "CHUKHA", "COOCH BEHAR", "COSSIPORE", "DAMSIBU", "DANKUNI", "DARJEELING", "DHAKA", "DHAMDARA", "DHULAGARH", "DINHATA", "DINHATA NEW SF", "FALAKATA", "GANGTOK", "GAZIPUR (BANGLADESH)", "GELPHU", "GOMTU", "HALDIA", "HOOGHLY", "HOWRAH", "HOWRAH-SA", "JALPAIGURI", "JANGALPUR", "JHAPA", "JIGMELING", "KACHUA", "KALIGHAT", "KALYANI", "KAMAREY", "KHARAGPUR", "LILUAH", "LILUHA", "MALDA", "MALI BAZAR", "MAMRING", "MANPUR", "MATHABHANGA", "MECHI NAGAR", "MEDINIPUR", "MEMARI", "MIDNAPORE", "MIRJATPUR", "MONGAR", "NADIA", "NAGRAKATA", "NALHATI", "NAMCHI", "NAMTHANG", "NANGLAM", "NARAYANGANJ", "NAXALBARI", "NGANGLAM", "PAKYONG", "PARGANA", "PARO", "PASAKHA", "PASCHIM MIDINIPUR", "PHODRANG", "PHUNTSHOLLING", "PUNAKHA", "PUNATSANGCHHU", "PURULIA", "RAGHUNATHPUR", "RAJNANDGOAN", "RALIYA", "RANGPOO", "RANINAGAR", "RANIPOOL", "RHENOCK", "RUMTEK", "SAMDRUP JONGKHAR", "SAMTSE", "SARPANG", "SILIGURI", "SINGTAM", "SONAMOSJID", "TARATALA", "THIMPU", "TRASHIGANG", "TRASHIYANGTSE", "TSIRANG", "ULUBERIA", "UTTAR DINAJPUR", "WANGDUE"],
};

// Field key -> sheet column / mail label, in display order (a function so Q is loaded first)
function webFields_() {
  return [
  ['repName', Q.REP_NAME], ['repEmail', Q.REP_EMAIL], ['visitDate', Q.VISIT_DATE],
  ['customer', Q.CUSTOMER], ['zone', 'Customer zone'], ['city', Q.CITY], ['contact', Q.CONTACT],
  ['phone', Q.PHONE], ['custEmail', Q.CUST_EMAIL], ['decision', Q.DECISION], ['business', Q.BUSINESS],
  ['currentTpt', Q.CURRENT_TPT], ['pain', Q.PAIN], ['expect', Q.EXPECT],
  ['mValue', Q.M_VALUE], ['mVolume', Q.M_VOLUME], ['mShip', Q.M_SHIP], ['freq', Q.FREQ],
  ['season', Q.SEASON], ['potValue', Q.POT_VALUE], ['potVolume', Q.POT_VOLUME],
  ['commodity', Q.COMMODITY], ['matType', Q.MAT_TYPE], ['load', Q.LOAD], ['pkgWt', Q.PKG_WT],
  ['dims', Q.DIMS], ['packing', Q.PACKING], ['handling', Q.HANDLING], ['risk', Q.RISK],
  ['origins', 'Origin branches'], ['destRegions', Q.DEST_REGIONS], ['destCities', 'Destination cities'],
  ['lanes', 'Lane mapping'], ['coverage', Q.COVERAGE],
  ['rateBasis', Q.RATE_BASIS], ['curRate', Q.CUR_RATE], ['expRate', Q.EXP_RATE], ['indRate', Q.IND_RATE],
  ['charges', Q.CHARGES], ['credit', Q.CREDIT], ['remarks', Q.REMARKS], ['followup', Q.FOLLOWUP]
  ];
}
var WEB_REQUIRED = ['repName', 'repEmail', 'visitDate', 'customer', 'zone', 'city', 'contact', 'phone',
  'mValue', 'mVolume', 'potValue', 'commodity', 'load', 'expRate', 'credit'];

function doGet() {
  var t = HtmlService.createTemplateFromFile('Index');
  t.masters = JSON.stringify(webMasters_());
  return t.evaluate()
    .setTitle('Sugam - Customer Visit')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/** Origin branches by zone come from tab "Masters" (so refreshFormOptions edits apply), else the script list. */
function webMasters_() {
  var byZone = ORIGINS_BY_ZONE;
  try {
    var ss = SpreadsheetApp.openById(PropertiesService.getScriptProperties().getProperty('SHEET_ID'));
    var rows = ss.getSheetByName('Masters').getDataRange().getValues().slice(1);
    var m = {};
    rows.forEach(function (r) {
      var z = String(r[0]).trim(), o = String(r[1]).trim();
      if (z && o) (m[z] = m[z] || []).push(o);
    });
    if (Object.keys(m).length) byZone = m;
  } catch (err) { /* fall back to script list */ }
  return { originsByZone: byZone, destByRegion: DEST_CITIES_BY_REGION };
}

/** Called from the page with google.script.run */
function submitVisit(p) {
  WEB_REQUIRED.forEach(function (k) {
    if (!p[k] || !String(p[k]).trim()) throw new Error('Missing: ' + k);
  });
  if (!p.lanes || !p.lanes.length) throw new Error('Add at least one lane');
  var WEB_FIELDS = webFields_();

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var ss = SpreadsheetApp.openById(PropertiesService.getScriptProperties().getProperty('SHEET_ID'));
    var now = new Date();
    var id = 'SV-' + Utilities.formatDate(now, Session.getScriptTimeZone(), 'yyyyMMdd-HHmmss') + '-' + Math.floor(Math.random() * 900 + 100);

    // derive flat lists from lanes
    var origins = [], cities = [], regions = [];
    var addU = function (arr, v) { if (v && arr.indexOf(v) < 0) arr.push(v); };
    p.lanes.forEach(function (l) {
      addU(origins, l.origin);
      (l.dests || []).forEach(function (d) { addU(cities, d.city); addU(regions, d.region); });
    });
    var laneText = p.lanes.map(function (l) {
      return l.origin + ' > ' + (l.dests || []).map(function (d) { return d.city; }).join(', ') +
        ' | ' + (l.mt || '-') + ' MT/month | ' + (l.freq || '-');
    }).join('\n');

    var a = {};
    WEB_FIELDS.forEach(function (f) {
      var v = p[f[0]];
      if (Array.isArray(v)) v = v.join(', ');
      a[f[0]] = v == null ? '' : String(v);
    });
    a.origins = origins.join(', ');
    a.destRegions = regions.join(', ');
    a.destCities = cities.join(', ');
    a.lanes = laneText;

    // Web_Responses
    var wr = ss.getSheetByName('Web_Responses');
    if (!wr) {
      wr = ss.insertSheet('Web_Responses');
      wr.appendRow(['Submitted At', 'Visit ID'].concat(WEB_FIELDS.map(function (f) { return f[1]; })));
      wr.getRange(1, 1, 1, WEB_FIELDS.length + 2).setFontWeight('bold').setBackground('#1f3864').setFontColor('#ffffff');
      wr.setFrozenRows(1);
    }
    wr.appendRow([now, id].concat(WEB_FIELDS.map(function (f) { return a[f[0]]; })));

    // Visit_Lanes: one row per origin > destination city
    var vl = ss.getSheetByName('Visit_Lanes');
    if (!vl) {
      vl = ss.insertSheet('Visit_Lanes');
      vl.appendRow(['Submitted At', 'Visit ID', 'Customer', 'Customer Zone', 'Origin Zone', 'Origin Branch',
        'Destination Region', 'Destination City', 'Lane MT / month', 'Frequency']);
      vl.getRange(1, 1, 1, 10).setFontWeight('bold').setBackground('#1f3864').setFontColor('#ffffff');
      vl.setFrozenRows(1);
    }
    var laneRows = [];
    p.lanes.forEach(function (l) {
      (l.dests || []).forEach(function (d) {
        laneRows.push([now, id, a.customer, a.zone, l.originZone || '', l.origin, d.region || '', d.city, l.mt || '', l.freq || '']);
      });
    });
    if (laneRows.length) vl.getRange(vl.getLastRow() + 1, 1, laneRows.length, 10).setValues(laneRows);

    // Mail
    var rows = WEB_FIELDS.map(function (f) { return [f[1], a[f[0]]]; });
    var status = sendVisitMail_(ss, a, rows);

    ss.getSheetByName('Visit_Summary').appendRow([now, a.visitDate, a.repName, a.repEmail, a.customer, a.zone,
      a.city, a.contact, a.phone, a.commodity, a.mValue, a.mVolume, a.potValue, a.origins, a.destRegions,
      a.destCities, a.expRate, status + ' (web ' + id + ')']);
    return { id: id, status: status };
  } finally {
    lock.releaseLock();
  }
}

function sendVisitMail_(ss, a, rows) {
  var settings = readSettings_(ss);
  var rm = findZone_(ss, a.zone);
  var to = [settings.COSTING_HEAD_EMAIL, rm.email].filter(String).join(',');
  var cc = [rm.cc, settings.ALWAYS_CC, (String(settings.CC_FIELD_REP).toUpperCase() === 'YES' ? a.repEmail : '')]
    .filter(String).join(',');
  var status;
  if (!to) {
    status = 'NOT SENT - fill COSTING_HEAD_EMAIL in Settings / RM email for ' + a.zone + ' in Zone_Emails';
  } else {
    var subject = 'New Customer Visit: ' + a.customer + ' | ' + a.zone + ' | Potential Rs ' + (a.potValue || '-') + '/month';
    var html = '<div style="font-family:Arial;font-size:13px;color:#1b2333">' +
      '<div style="background:#1f3864;color:#fff;padding:14px 18px;border-radius:8px 8px 0 0">' +
      '<div style="font-size:12px;opacity:.8">SUGAM GROUP - CUSTOMER VISIT</div>' +
      '<div style="font-size:18px;font-weight:bold">' + esc_(a.customer) + '</div>' +
      '<div>' + esc_(a.city) + ' | Zone ' + esc_(a.zone) + ' | Potential Rs ' + esc_(a.potValue) + '/month</div></div>' +
      '<p>Visited by <b>' + esc_(a.repName) + '</b> on ' + esc_(a.visitDate) +
      '. Please review for HO costing &amp; P&amp;L (Step 06).</p>' +
      '<table cellpadding="6" style="border-collapse:collapse">' +
      rows.filter(function (r) { return r[1]; }).map(function (r, i) {
        return '<tr style="background:' + (i % 2 ? '#ffffff' : '#f2f5fa') + '"><td style="border:1px solid #d0d7e2;width:260px"><b>' +
          esc_(r[0]) + '</b></td><td style="border:1px solid #d0d7e2">' + esc_(r[1]).replace(/\n/g, '<br>') + '</td></tr>';
      }).join('') + '</table>' +
      '<p>Full data: <a href="' + ss.getUrl() + '">' + SHEET_NAME + '</a></p></div>';
    try {
      var mail = { to: to, cc: cc, subject: subject, htmlBody: html, name: 'Sugam Customer Visit' };
      if (a.repEmail) mail.replyTo = a.repEmail;
      MailApp.sendEmail(mail);
      status = 'SENT' + (rm.email ? '' : ' (no RM email for ' + a.zone + ', only Costing Head)');
    } catch (err) {
      status = 'FAILED: ' + err.message;
    }
  }
  ss.getSheetByName('Mail_Log').appendRow([new Date(), a.customer, a.zone, to + (cc ? ' | cc: ' + cc : ''), status]);
  return status;
}
