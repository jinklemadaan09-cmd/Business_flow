/**
 * SUGAM GROUP - Customer Onboarding Journey: shared helpers for the web app (WebApp.gs).
 * The old Google Form setup code (setup, onVisitSubmit, refreshFormOptions) is no longer used and was removed.
 */

// Built-in copy of origin branches by zone, used only when the GR PNL data master cannot be read
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
