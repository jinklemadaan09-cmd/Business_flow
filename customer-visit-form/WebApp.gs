/**
 * SUGAM GROUP - Customer Visit web app (custom HTML form + admin panel)
 *
 * Lives in the SAME Apps Script project as Sugam_Customer_Visit_Form.gs
 * (setup() must have been run there once). Files in the project:
 *   Sugam_Customer_Visit_Form.gs (or Code.gs), WebApp.gs, Index.html, Admin.html
 *
 * Deploy > New deployment > Web app > Execute as: Me > Who has access: Anyone.
 *   Field reps:  <web app URL>
 *   Admin:       <web app URL>?page=admin   (PIN = ADMIN_PIN in tab Settings)
 *
 * Tabs it uses in the response sheet:
 *   Form_Config    every question (admin edits it from the admin page)
 *   Web_Responses  one row per visit; one column per question, kept in sync with Form_Config
 *   Visit_Lanes    one row per origin > destination (one origin can have many destinations)
 *   Visit_Summary, Mail_Log, Zone_Emails, Settings   (same as the Google Form)
 *
 * Zones and locations come from the dashboard master (engine spreadsheet tabs LANE_ORIGIN,
 * LANE_DEST). Put its link in Settings > DASHBOARD_MASTER_SHEET. Until then the lane master
 * copy inside this script is used.
 */

var CONFIG_SHEET = 'Form_Config';
var CONFIG_HEADERS = ['Field_ID', 'Step', 'Order', 'Label', 'Type', 'Required', 'Options', 'Help', 'Active', 'Locked'];
var STEP_NAMES = ['Customer Visit', 'Monthly Business Potential', 'Material Understanding',
  'Origin & Destination Mapping', 'Indicative Rate Discussion'];
var FIELD_TYPES = ['text', 'textarea', 'number', 'money', 'date', 'email', 'tel', 'single', 'multi', 'dropdown', 'zone', 'flows'];
var MASTER_CACHE_KEY = 'visit_masters_v2';
var FLOWS_HELP = 'One block per origin. Tick all its destinations in one go, then add a new block for the next origin.';
var OLD_FLOWS_HELP = 'One card per flow. Add stops in order: origin, then every place the material goes next.';

var SETTING_DEFAULTS = [
  ['DASHBOARD_MASTER_SHEET', '', 'Link (or ID) of the dashboard engine spreadsheet with tabs LANE_ORIGIN and LANE_DEST'],
  ['ORIGIN_ZONE_COLUMN', 'Booking Lane', 'Column of LANE_ORIGIN used as origin zone'],
  ['DEST_ZONE_COLUMN', 'Broader Lane (L2)', 'Column of LANE_DEST used as destination zone'],
  ['ADMIN_PIN', '', 'PIN for the admin page (<web app URL>?page=admin). Empty = admin page locked']
];

// Field_ID, Step, Label, Type, Required, Options (one per line), Help, Locked
var DEFAULT_FIELDS = [
  ['repName', 1, 'Your name', 'text', 1, '', '', 1],
  ['repEmail', 1, 'Your email', 'email', 1, '', '', 1],
  ['visitDate', 1, 'Visit date', 'date', 1, '', '', 1],
  ['customer', 1, 'Customer / company name', 'text', 1, '', '', 1],
  ['zone', 1, 'Customer zone', 'zone', 1, '', 'Decides which Regional Manager gets the mail', 1],
  ['city', 1, 'Customer city / location', 'text', 1, '', '', 0],
  ['contact', 1, 'Contact person & designation', 'text', 1, '', '', 0],
  ['phone', 1, 'Contact mobile', 'tel', 1, '', '', 0],
  ['custEmail', 1, 'Customer email', 'email', 0, '', '', 0],
  ['decision', 1, 'Decision makers (name / role)', 'text', 0, '', '', 0],
  ['business', 1, 'Business model / industry', 'text', 0, '', '', 0],
  ['currentTpt', 1, 'Current transport set-up', 'textarea', 0, '', 'Current transporter, mode, issues', 0],
  ['pain', 1, 'Pain points', 'textarea', 0, '', '', 0],
  ['expect', 1, 'Service expectations', 'textarea', 0, '', 'TAT, pickup, POD, tracking etc.', 0],
  ['mValue', 2, 'Current monthly freight spend', 'money', 1, '', '', 0],
  ['mVolume', 2, 'Current monthly volume (MT)', 'number', 1, '', '', 0],
  ['mShip', 2, 'Shipments / dockets per month', 'number', 0, '', '', 0],
  ['freq', 2, 'Dispatch frequency', 'single', 0, 'Daily\n2-3 times a week\nWeekly\nFortnightly\nMonthly', '', 0],
  ['season', 2, 'Seasonality (peak / lean months)', 'text', 0, '', '', 0],
  ['potValue', 2, 'Potential monthly business with Sugam', 'money', 1, '', '', 1],
  ['potVolume', 2, 'Potential monthly volume (MT)', 'number', 0, '', '', 0],
  ['commodity', 3, 'Commodity / material description', 'text', 1, '', '', 0],
  ['matType', 3, 'Material category', 'multi', 0, 'FMCG\nTextiles / Garments\nPharma\nElectronics\nAuto parts\nMachinery / Spares\nChemicals\nHardware / Building material\nPaper / Printing\nPlastic / Polymers\nFood grains / Agro\nOther', '', 0],
  ['load', 3, 'Load type', 'single', 1, 'Part load (LTL)\nFull truck load (FTL)\nBoth', '', 0],
  ['pkgWt', 3, 'Avg weight per package (kg)', 'number', 0, '', '', 0],
  ['dims', 3, 'Package dimensions (L x W x H)', 'text', 0, '', '', 0],
  ['packing', 3, 'Packing type', 'multi', 0, 'Carton\nBags / Bora\nBundles\nDrums\nWooden crate\nPallet\nLoose', '', 0],
  ['handling', 3, 'Special handling needs', 'textarea', 0, '', '', 0],
  ['risk', 3, 'Special risks / restrictions', 'textarea', 0, '', 'Hazardous, fragile, high value, permits', 0],
  ['flows', 4, 'Origin & destination lanes', 'flows', 1, '', FLOWS_HELP, 1],
  ['coverage', 4, 'Branch coverage & feasibility', 'single', 0, 'All lanes covered\nPartly covered\nNot covered / new arrangement', '', 0],
  ['rateBasis', 5, 'Rate basis', 'single', 0, 'Per kg\nPer package\nPer vehicle (FTL)', '', 0],
  ['curRate', 5, 'Customer current rate', 'money', 0, '', '', 0],
  ['expRate', 5, 'Rate expected by customer', 'money', 1, '', '', 0],
  ['indRate', 5, 'Indicative rate discussed by us', 'money', 0, '', '', 0],
  ['charges', 5, 'Other charges discussed', 'multi', 0, 'Fuel surcharge\nFOV / Insurance\nFOD\nDocket charge\nODA\nHandling\nDoor delivery', '', 0],
  ['credit', 5, 'Credit period required', 'single', 1, 'Advance / To pay\n15 days\n30 days\n45 days\n60 days\n90 days', '', 0],
  ['followup', 5, 'Next follow-up date', 'date', 0, '', '', 0],
  ['remarks', 5, 'Remarks / next steps', 'textarea', 0, '', '', 0]
];

// Fallback destination list by Broader Lane (L2), used until DASHBOARD_MASTER_SHEET is set
var DEST_BY_ZONE_FALLBACK = {
  "ANDHRA PRADESH CIRCLE": ["ANANT PUR", "AUTONAGAR (HYD)", "CHITTOOR", "GUNTUR", "HINDUPUR", "HYDERABAD", "JEEDIMETLA (HYD)", "KAKINADA", "KARIMNAGAR", "KHAMMAM", "KONDAPALLY", "KURNOOL", "LALAGUDA", "MAHABOOB NAGAR", "MEDAK", "MEDCHAL", "NALGONDA", "PATANCHERU (HYD)", "RANGAREDDY", "SANGAREDDY", "SECUNDRABAD", "SIDDIPET", "SRIKAKULAM", "TIRUPATI", "VIJAYAWADA", "VISHAKHAPATNAM", "WARANGAL"],
  "ASSAM - NE": ["ABHAYAPURI", "ABHOYNAGAR (AGT)", "AGARTALA", "AGARTALA BAZAR", "AGARTALA TOWN", "AIZWAL", "AIZWAL CITY", "AMBASSA (AGT)", "AMINGAON (GHT)", "AMONI", "AMUGURI (JRT)", "BADARPUR", "BAIHATA CHARIALI", "BANDERDEWA", "BARPETA", "BELONIA (TRIPURA)", "BELTALA (PAMOHI)", "BHALUKPONG", "BHOLAGANJ BAZAR (SLLG)", "BIJOYNAGAR", "BILASIPARA", "BINOVANAGAR", "BISHNUPUR (SLLG)", "BOKAJAN", "BOKO", "BONGAIGAON", "BYRNIHAT (GHT)", "CACHAR", "CHAMPHAI (AZL)", "CHANGLANG", "CHANGSARI", "CHHAYGAON", "CHIRANG", "CHUMUKDIMA (DMP)", "CHURACHANDPUR", "DARRANG", "DAYAPUR (CRPF)", "DERGAON", "DHARMANAGAR", "DHEKIAJULI", "DHEMAJI", "DHUBRI", "DIBRUGARH", "DIMAPUR", "DIMAPUR TOWN AREA (DMP)", "DIPHU", "DIRANG", "DISPUR", "DOIMUKH", "DULIAJAN", "DURTLANG (AZL)", "GOALPARA", "GOALPARA (GHT)", "GOHPUR", "GOLAGHAT (JRT)", "GUWAHATI", "GUWAHATI CITY", "GUWAHATI G P O", "HAFLONG", "HAILA KANDI", "HOJAI (GHT)", "IEWDUH (SLLG)", "IMPHAL", "ITA NAGAR", "JAGIROAD", "JAIRAMPUR", "JORABAT", "JORHAT", "KAILASAHAR (DRMNGR)", "KAKRABAN (AGT)", "KAMALPUR (AGT)", "KAMRUP", "KARIMGANJ", "KHANAPARA (GHT)", "KHARUPETIA", "KHATKHATI (GHT)", "KHAWZAWL (AZL)", "KHAYERPUR", "KHOWAI (AGT)", "KIPHIRE", "KOHIMA", "KOKRAJAR", "KOLASIB (AZL)", "KUMARGHAT", "LABAN (SLLG)", "LADRYMBAI", "LAITKOR (SLLG)", "LAITRYNGEW (SLLG)", "LAITUMKHRAH (SLLG)", "LAWNGTLAI (AZL)", "LEMBUCHERRA", "LUMDING", "LUNGLEI (AZL)", "MAMIT (AZL)", "MANU (AGT)", "MASIMPUR", "MAWSMAI", "MELAGHAR (AGT)", "MIRZA", "MISAMARI", "MISSAMARI (TZP)", "MIZORAM UNIVERSITY (AZL)", "MOKOKCHUNG", "MORANHAT (JRT)", "MORIGAON", "NAGAON", "NAHARLAGUN", "NALBARI", "NALTOLI", "NAMRUP (JRT)", "NAMSAI", "NARANGI SATGAON", "NONGPOH (SLLG)", "NORTH LAKIMPUR", "NUMALIGARH", "OAKLAND (SLLG)", "PALASHBARI", "PANDU", "PANIKHAITI", "PAPUM PARE", "PASIGHAT", "RANGIA", "REHABARI", "RIBHOI", "SAITUAL (AZL)", "SANTIBAZAR", "SELING (AZL)", "SERCHHIP (AZL)", "SHILLONG", "SHIV SAGAR", "SIDHAI MOHANPUR (AGT)", "SILAPATHAR", "SILCHAR", "SONAPUR (GHT)", "SONITPUR", "SORBHOG", "TANGLA (GHT)", "TELIAMURA (AGT)", "TEZPUR", "TEZU", "TINSUKIA", "TURA", "UDAIPUR (TRIPURA)", "ULUBARI", "UMSNING (SLLG)", "UPPER SHILLONG", "YUPIA"],
  "DELHI-NCR": ["ALIGARH-SF", "ALIPUR", "AMBALA CANT", "BAHADURGARH NEW (CLOSED)", "BAWAL", "BAWANA", "BHIWADI", "BILASPUR-HR", "DELHI", "DELHI-ADARSH NAGAR SF", "DELHI-BHAJANPURA SF", "DELHI-C.CHOWK", "DELHI-DARYAGANJ", "DELHI-GANDHI NAGAR", "DELHI-K.GATE OFFICE", "DELHI-KAROL BAGH", "DELHI-MUNDKA", "DELHI-NANGLOI", "DELHI-NARAINA", "DELHI-OKHLA", "DELHI-S.BAZAR", "DELHI-T.P.NAGAR", "DELHI-TIKRI BORDER", "DELHI-V.NAGAR", "FARIDABAD", "FARRUKH NAGAR", "GHAZIABAD", "GURGAON", "HAPUR", "HISAR", "IGI AIRPORT (DELHI)", "JHAJJAR", "KAITHAL", "KARNAL", "KUNDLI", "MANESAR", "MEERUT", "MORADABAD", "NEEMRANA", "NOIDA", "NOIDA-88", "PANIPAT", "RAILWAY STATION (BADLI)", "ROHTAK", "ROHTAK (CLOSED)", "SAHIBABAD", "SIKANDRABAD", "SONEPAT", "SONIPAT", "SURAJPUR (G.NOIDA)", "U.P.BORDER"],
  "GUJARAT": ["AHMEDABAD", "ANJAR", "ANKLESHWAR", "ASLALI", "BARODA", "BHARUCH", "BHAV NAGAR", "CHATRAL", "CHHATRAL", "DAHEJ", "DAHEJ (GJ)", "DHANERA", "GANDHI DHAM", "HALOL", "JAMNAGAR", "JETALPUR", "KOSAMBA", "KUTCH", "MUNDRA", "MUNDRA PORT", "ODHAV", "RAJKOT", "SACHIN", "SANAND", "SARKHEJ", "SURAT", "SURAT CITY", "SURENDER NAGAR", "UMBERGAON", "VALSAD", "VAPI", "VATVA"],
  "INDO NEPAL CIRCLE": ["BARDHIAH"],
  "JHARKHAND CIRCLE": ["BOKARO", "CHATRA", "DALTANGANJ", "DEOGARH", "DHANBAD", "GARHWA", "GIRIDIH", "GODDA", "KODERMA", "RANCHI", "TATANAGAR"],
  "KARNATAKA CIRCLE": ["BAGALKOT", "BANGALORE", "BANGALORE CITY", "BELGAUM", "BELLARY", "BOMMASANDRA", "BOMMASANDRA BNG", "DAVANGIRI", "DHARWAD", "GULBARGA", "HAROHALLI", "HASSAN", "HOSKOTE", "HOSUR", "HUBLI", "KOPAL", "MALUR", "MANGALORE", "MANGLORE", "MYSURE", "NELAMANGALA", "RAICHUR", "TUMKUR"],
  "KERALA CIRCLE": ["ALPHOUZA (KERALA)", "CHALAKUDI", "COCHIN", "ERNAKULAM", "KANNUR", "KASARAGOD", "KOCHI", "KOLLAM", "KOTTAYAM", "KOZHIKODE", "PALAKKAD", "THIRUVANANTHAPURAM"],
  "MADHYA PRADESH": ["BHOPAL", "CHHINDWARA", "DEWAS", "HOSHANGABAD", "INDORE", "ITARSI", "JABALPUR", "KATNI", "KHANDWA", "MALANPUR", "MANDIDEEP", "MORENA", "PALDA", "PATHARI", "PITHAM PUR", "PITHAMPUR", "RAISEN", "REWA", "SAGAR", "SATNA", "SIDHI", "UJJAIN"],
  "MAHARASHTRA": ["AHMEDNAGAR", "AMBERNATH", "AMBERNATH (CLOSED)", "AMRAVATI", "AURANGABAD", "BEED", "BHIWANDI", "BHUSAWAL", "BOREGAON", "CHANDRAPUR", "DOLVI", "GOA", "JALGAON OFFICE", "KALAMBOLI", "KANDIVALI", "KIRANDUL", "KOLHAPUR", "LATUR", "MUMBAI", "MUMBAI (ANDHERI)", "NAGPUR", "NASIK", "NAVI MUMBAI", "NHAVA SEVA", "NHAVASHEVA", "PALGHAR NEW SF", "PANVEL", "PATALGANGA", "POONA", "PUNE", "PUNE AIRPORT", "PURNA (BHIWANDI)", "RAIPUR", "RANJANGAON", "RANJIT NAGAR", "SANGLI", "SOLAPUR", "TALOJA", "TARAPUR", "URAN", "VASAI", "WAI", "YAVATMAL"],
  "NEPAL CIRCLE": ["ADARSH NAGAR", "AMLEKHGANJ", "BAGLUNG", "BAGMATI ZONE", "BALAJU", "BALUWATAR", "BANDIPUR", "BANEPA", "BANKA", "BANKEY", "BANSGADHI", "BARA", "BARAHATHAWA", "BARDGHAT", "BARDIVASH", "BARDIYA", "BARGACHHI", "BASANTAPUR", "BHAIRAHAWA", "BHAIRAWA-CUSTOM", "BHAKTAPUR", "BHARATPUR (NP)", "BHATBHATENI", "BIRATNAGAR", "BIRATNAGAR TO", "BIRENDRA NAGAR", "BIRGUNJ", "BIRGUNJ TO", "BIRTAMODE", "BUTWAL", "CHABAHIL", "CHANDRAUTA", "CHHATAPIPRA", "CHITWAN", "CHITWOR-NP", "CHORNI", "DAMAK", "DAMAULI", "DAMKAULI", "DANG", "DANG (BARHNI)", "DHADING (NP)", "DHALKEBAR", "DHALKEWARE", "DHANGADHI", "DHANGURHI-BHANSAR", "DHANGURI", "DHANUSHA", "DHARAN", "DUHABI", "DUMKIBAS", "GAINDAKOT", "GAIRIDHARA", "GALESHWAR", "GANDAKI", "GARUDA", "GAURADAHA", "GAUSHALA", "GHANTAGHAR", "GHORAHI", "GORKHA", "GULARIYA", "GULMI", "HARIYON", "HETAUDA", "HETAUDA TO", "ITAHARA", "ITAHARI", "JALESHWAR", "JALESHWAR (NP)", "JANAKPUR", "JANAKPUR DHAM", "JANAKPURDHAM", "JEETPUR", "JHAPA", "JOGBANI", "KAILALI", "KAKARBHITTA", "KALANKI", "KAMALADI", "KANCHANPUR", "KAPILVASTU", "KAPILVASTU (BARHNI)", "KASKI", "KATHMANDU", "KATHMANDU TO", "KAVRE", "KHANAR", "KHANDBARI", "KOHALPUR", "KOTESHWOR", "KOTHIWAHA", "KRISHANA NAGAR", "KURINTAR", "LAHAN", "LALITPUR", "LIPANIMAL", "LUMBINI", "MADI", "MAHARAJGANJ", "MAHENDRANAGAR", "MAHOTTARI", "MAKWANPUR", "MALANGWA", "MECHI", "MECHI NAGAR", "MIRCHAIYA", "MORANG", "MUKUNDAPUR", "MUSTANG (N)", "NARAINGHAT", "NARAINGHAT TO", "NARAYAN GARH", "NARAYANI", "NAWALPARASI", "NAWALPUR", "NAXAL", "NEPALGANJ", "NUWAKOT", "PADSARI", "PALIA", "PALPA", "PANAUTI", "PANCHKHAL", "PARASI", "PARSA", "PARWANIPUR", "POKHARIA", "POKHRA", "POKHRA TO", "RAHUGHAT", "RAMGADHWA", "RAMNAGAR-NEPAL", "RAMPUR-TOKNI", "RAUTAHAT", "RAXAUL", "ROLPA (NEPAL)", "RUPAIDIHA", "RUPANDEHI", "SAMAKHUSI", "SAPTARI", "SARLAHI", "SHREEPUR", "SIDDHARTHA NAGAR (NEPAL)", "SIMARA", "SIMRA", "SINDHUPAL CHOWK", "SIRAHA MIRCHAYA", "SIRHA", "SUNAULI", "SUNSARI", "SURKHET", "SYANGJA", "TANAHUN", "TAPLEJUNG", "THAPATHALI-NP", "TILOTTAMA", "TRIPURESHWAR", "UDAYAPUR (NEPAL)"],
  "ORISSA CIRCLE": ["ANGUL", "ATHAGARH", "BALASORE", "BALUGAON", "BARBIL", "BERHAMPUR", "BHADRAK", "BHILAI", "BHUBNESHWAR", "BILASPUR", "BONDAMUNDA", "CUTTACK", "DHENKANAL", "JAGATSINGHPUR", "JHARSAGUDA", "KEONJHAR", "KORAPUT", "MAYURBHANJ", "RAIGARH-CG", "RAMGARH", "RAYAGADA", "ROURKELA", "SAMBALPUR", "SUBARNAPUR"],
  "PATNA CIRCLE": ["ARARIA", "ARRAH", "ARRAH-SF", "AURANGABAD (BIHAR)", "BARAUNI", "BEGUSARAI", "BETTIAH", "BHAGAL PUR", "BHITTAMORE", "CHAMPARAN", "CHAPRA", "DANAPUR", "DARBHANGA", "EAST CHAMPARAN", "FORBESGANJ", "GARHARA", "GAYA", "GOPAL GANJ", "HAJIPUR", "JAMSHEDPUR (JK)", "JAMUI", "JEHANABAD", "KATIHAR", "KHAGARIA", "KISHANGANJ", "MADHUBANI", "MOTIHARI", "MUNGER", "MUZAFFARPUR", "NALANDA", "NAWADA", "PAKRIDAYAL", "PATNA", "PATNA CITY", "PURNEA", "RAMGARHWA", "ROHTAS", "SAHARSA", "SAMASTIPUR", "SARAN", "SASARAM", "SITAMARHI", "SIWAN", "SUGAULI", "VAISHALI"],
  "PUNJAB CIRCLE": ["AMBALA", "AMRITSAR", "ANANDPUR", "BADDI", "BATHINDA", "CHANDIGARH", "DERA BASI", "JALANDHAR", "JAMMU", "JAMMU-SF", "KAPURTHALA", "LALRU", "LEH LADAKH", "LUDHIANA", "LUDHIANA T.P.NAGAR", "MANALI", "MOGA", "MOHALI", "PANCHKULA", "PARWANOO", "PATIALA", "UDHAM PUR", "ZIRAKPUR"],
  "RAJASTHAN": ["AJMER", "ALWAR", "BARMER", "BEAWAR", "BEHROR", "JAIPUR", "JAISALMER", "JODHPUR", "KAMAN", "KOTA", "MARWAR MUNDWA", "NEWAI", "UDAIPUR"],
  "TAMIL NADU CIRCLE": ["AMBATTUR", "ARAKKONAM", "CHENNAI", "CHENNAI-SF", "COIMBATORE", "CUDDALORE", "DINDIGUL", "ERODE", "GUDUVANCHERI", "KANCHIPURAM", "KARUR NEW SF", "KRISHNAGIRI", "MADHAVARAM", "MADRAS", "MADURAI", "MANCHERIAL", "ORAGADAM", "PUDUCHERRY", "RADHAPURAM", "SRICITY", "SRIPERUMBUDUR", "THOOTHUKUDI", "TIRUPUR", "TUTICORAIN"],
  "UTTAR PRADESH": ["AGRA", "AYODHYA", "AZAMGARH", "BAHRAICH", "BANDA", "BARABANKI", "BAREILLY (CLOSED)", "BARHNI", "BULANDSHAHR", "DEORIA", "ETAH", "FAIZABAD", "FARUKABAD", "GONDA", "GORAKPUR", "GUNJDUNDWARA", "GWALIOR", "HARDOI", "HATHRAS", "JAUNPUR", "KANPUR", "KUSHINAGAR", "LONI", "LUCKNOW", "MIRZA PUR", "MUZAFFARNAGAR (CLOSED)", "NAUTANWA", "NICHLAUL", "PITHORAGARH", "PRATAPGARH", "PRAYAGRAJ", "RAIBARELLY", "SHAHJAHANPUR", "SONBHADRA", "VARANASI"],
  "UTTRAKHAND CIRCLE": ["ALMORA", "DEHRADUN", "HARIDWAR", "KASHIPUR", "KASSIPUR", "KICHHA", "PANTNAGAR", "RISHIKESH", "ROORKEE", "RUDRAPUR", "SAHARANPUR", "SELAQUI", "SITARGANJ"],
  "WEST BENGAL": ["AGARPARA", "ALAMPUR -SA", "ALIPURDUAR", "AMBIKAPUR", "ASANSOL", "BAGDOGRA", "BAJO", "BANGAON", "BANKURA", "BARASAT", "BARDHAMAN", "BASIRHAT", "BENAPOLE", "BHATPARA", "BHUMTHANG", "BIRBHUM", "BISHNUPUR", "BONHOOGHLY", "BURDWAN", "CHANGZAMTOG", "CHITTARANJAN", "CHUKHA", "COOCH BEHAR", "COSSIPORE", "DAMSIBU", "DANKUNI", "DARJEELING", "DHAKA", "DHAMDARA", "DHULAGARH", "DINHATA", "DINHATA NEW SF", "FALAKATA", "GANGTOK", "GAZIPUR (BANGLADESH)", "GELPHU", "GOMTU", "HALDIA", "HOOGHLY", "HOWRAH", "HOWRAH-SA", "JAIGAON", "JALPAIGURI", "JANGALPUR", "JIGMELING", "KACHUA", "KALIGHAT", "KALYANI", "KAMAREY", "KHARAGPUR", "LILUAH", "LILUHA", "MALDA", "MALI BAZAR", "MAMRING", "MANPUR", "MATHABHANGA", "MEDINIPUR", "MEMARI", "MIDNAPORE", "MIRJATPUR", "MONGAR", "NADIA", "NAGRAKATA", "NALHATI", "NAMCHI", "NAMTHANG", "NANGLAM", "NARAYANGANJ", "NAXALBARI", "NGANGLAM", "PAKYONG", "PARGANA", "PARO", "PASAKHA", "PASCHIM MIDINIPUR", "PETRAPOLE", "PHODRANG", "PHUNTSHOLLING", "PUNAKHA", "PUNATSANGCHHU", "PURULIA", "RAGHUNATHPUR", "RAJNANDGOAN", "RALIYA", "RANGPOO", "RANINAGAR", "RANIPOOL", "RHENOCK", "RUMTEK", "SAMDRUP JONGKHAR", "SAMTSE", "SARPANG", "SILIGURI", "SINGTAM", "SONAMOSJID", "TARATALA", "THIMPU", "TRASHIGANG", "TRASHIYANGTSE", "TSIRANG", "ULUBERIA", "UTTAR DINAJPUR", "WANGDUE"],
};

/* ------------------------------------------------------------------ pages */

function doGet(e) {
  var admin = e && e.parameter && e.parameter.page === 'admin';
  var t = HtmlService.createTemplateFromFile(admin ? 'Admin' : 'Index');
  if (!admin) {
    var ss = responseSheet_();
    t.boot = JSON.stringify({ steps: STEP_NAMES, fields: activeFields_(readConfig_(ss)), masters: getMasters_(ss) })
      .replace(/</g, '\\u003c');
  } else {
    t.boot = JSON.stringify({ steps: STEP_NAMES, types: FIELD_TYPES });
  }
  return t.evaluate()
    .setTitle(admin ? 'Sugam - Visit Form Admin' : 'Sugam - Customer Visit')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function responseSheet_() {
  return SpreadsheetApp.openById(PropertiesService.getScriptProperties().getProperty('SHEET_ID'));
}

/* ----------------------------------------------------------------- config */

function readConfig_(ss) {
  var sh = ss.getSheetByName(CONFIG_SHEET);
  if (!sh) {
    sh = ss.insertSheet(CONFIG_SHEET);
    var rows = DEFAULT_FIELDS.map(function (f, i) {
      return [f[0], f[1], i + 1, f[2], f[3], f[4] ? 'YES' : 'NO', f[5], f[6], 'YES', f[7] ? 'YES' : 'NO'];
    });
    sh.getRange(1, 1, 1, CONFIG_HEADERS.length).setValues([CONFIG_HEADERS])
      .setFontWeight('bold').setBackground('#1f3864').setFontColor('#ffffff');
    sh.getRange(2, 1, rows.length, CONFIG_HEADERS.length).setValues(rows);
    sh.setFrozenRows(1);
  }
  var vals = sh.getDataRange().getValues();
  vals.forEach(function (r, i) {   // one-time update of the old multi-stop wording
    if (String(r[0]).trim() === 'flows' && String(r[7]) === OLD_FLOWS_HELP) {
      sh.getRange(i + 1, 4).setValue('Origin & destination lanes');
      sh.getRange(i + 1, 8).setValue(FLOWS_HELP);
      r[3] = 'Origin & destination lanes'; r[7] = FLOWS_HELP;
    }
  });
  return vals.slice(1).filter(function (r) { return String(r[0]).trim(); }).map(function (r) {
    return {
      id: String(r[0]).trim(), step: Number(r[1]) || 1, order: Number(r[2]) || 0, label: String(r[3]),
      type: String(r[4]).trim() || 'text', required: yes_(r[5]),
      options: String(r[6] || '').split('\n').map(function (s) { return s.trim(); }).filter(String),
      help: String(r[7] || ''), active: yes_(r[8]), locked: yes_(r[9])
    };
  }).sort(function (a, b) { return a.step - b.step || a.order - b.order; });
}

function activeFields_(config) { return config.filter(function (f) { return f.active; }); }
function yes_(v) { return /^(yes|y|true|1)$/i.test(String(v).trim()); }

/* ---------------------------------------------------------------- masters */

/** Unique origin zones > branches and destination zones > places, from the dashboard master. */
function getMasters_(ss) {
  var cache = CacheService.getScriptCache();
  var hit = cache.get(MASTER_CACHE_KEY);
  if (hit) return JSON.parse(hit);
  var settings = settingsWithDefaults_(ss);
  var m = null;
  var id = sheetIdFrom_(settings.DASHBOARD_MASTER_SHEET);
  if (id) {
    try {
      var eng = SpreadsheetApp.openById(id);
      m = {
        source: 'Dashboard master: ' + eng.getName(),
        origins: groupBy_(eng.getSheetByName('LANE_ORIGIN'), 'Origin', settings.ORIGIN_ZONE_COLUMN),
        dests: groupBy_(eng.getSheetByName('LANE_DEST'), 'Destination', settings.DEST_ZONE_COLUMN)
      };
    } catch (err) {
      m = null;
      Logger.log('Dashboard master not readable: ' + err.message);
    }
  }
  if (!m) m = { source: 'Built-in lane master copy (set DASHBOARD_MASTER_SHEET in Settings)', origins: ORIGINS_BY_ZONE, dests: DEST_BY_ZONE_FALLBACK };
  try { cache.put(MASTER_CACHE_KEY, JSON.stringify(m), 600); } catch (err) { /* too big to cache */ }
  return m;
}

function groupBy_(sh, nameCol, zoneCol) {
  if (!sh) throw new Error('Tab missing in dashboard master');
  var v = sh.getDataRange().getValues();
  var h = v[0].map(function (x) { return String(x).trim().toUpperCase(); });
  var ni = h.indexOf(nameCol.toUpperCase()), zi = h.indexOf(String(zoneCol).trim().toUpperCase());
  if (ni < 0 || zi < 0) throw new Error('Column ' + nameCol + ' / ' + zoneCol + ' not found in ' + sh.getName());
  var out = {};
  v.slice(1).forEach(function (r) {
    var n = String(r[ni]).trim(), z = String(r[zi]).trim() || 'OTHER';
    if (!n) return;
    out[z] = out[z] || [];
    if (out[z].indexOf(n) < 0) out[z].push(n);
  });
  Object.keys(out).forEach(function (z) { out[z].sort(); });
  return out;
}

function sheetIdFrom_(s) {
  s = String(s || '').trim();
  var m = s.match(/\/d\/([a-zA-Z0-9_-]{20,})/);
  return m ? m[1] : (/^[a-zA-Z0-9_-]{20,}$/.test(s) ? s : '');
}

function settingsWithDefaults_(ss) {
  var sh = ss.getSheetByName('Settings');
  var have = readSettings_(ss);
  SETTING_DEFAULTS.forEach(function (d) {
    if (!(d[0] in have)) { sh.appendRow(d); have[d[0]] = d[1]; }
  });
  return have;
}

/* -------------------------------------------------------- sheet columns */

/**
 * Web_Responses columns follow Form_Config: each question column carries a note "fid:<Field_ID>".
 * New question = new column, renamed = header renamed, removed = header gets "(removed)" and old data stays.
 */
function syncResponseColumns_(ss, config) {
  var sh = ss.getSheetByName('Web_Responses');
  if (!sh) {
    sh = ss.insertSheet('Web_Responses');
    sh.getRange(1, 1, 1, 2).setValues([['Submitted At', 'Visit ID']]);
    sh.setFrozenRows(1);
  }
  var lastCol = Math.max(sh.getLastColumn(), 2);
  var notes = sh.getRange(1, 1, 1, lastCol).getNotes()[0];
  var colOf = {};
  notes.forEach(function (n, i) { var m = String(n).match(/^fid:(.+)$/); if (m) colOf[m[1]] = i + 1; });
  config.forEach(function (f) {
    var title = f.active ? f.label : f.label + ' (removed)';
    if (colOf[f.id]) {
      var cell = sh.getRange(1, colOf[f.id]);
      if (cell.getValue() !== title) cell.setValue(title);
    } else if (f.active) {
      lastCol += 1;
      if (lastCol > sh.getMaxColumns()) sh.insertColumnAfter(sh.getMaxColumns());
      sh.getRange(1, lastCol).setValue(title).setNote('fid:' + f.id);
      colOf[f.id] = lastCol;
    }
  });
  sh.getRange(1, 1, 1, lastCol).setFontWeight('bold').setBackground('#1f3864').setFontColor('#ffffff');
  return { sheet: sh, colOf: colOf, width: lastCol };
}

/* ----------------------------------------------------------------- submit */

/** Called from the form page with google.script.run */
function submitVisit(p) {
  var ss = responseSheet_();
  var fields = activeFields_(readConfig_(ss));
  var flows = (p.flows || []).filter(function (fl) { return fl.origin && (fl.origin.zone || (fl.dests && fl.dests.length)); });

  fields.forEach(function (f) {
    if (!f.required) return;
    if (f.type === 'flows') {
      if (!flows.length || flows.some(function (fl) { return !fl.origin.zone || !fl.dests || !fl.dests.length; }))
        throw new Error('Each origin needs a zone and at least one destination');
      return;
    }
    var v = p[f.id];
    if (v == null || (Array.isArray(v) ? !v.length : !String(v).trim())) throw new Error('Missing: ' + f.label);
  });

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var now = new Date();
    var id = 'SV-' + Utilities.formatDate(now, Session.getScriptTimeZone(), 'yyyyMMdd-HHmmss') + '-' + Math.floor(Math.random() * 900 + 100);
    var placeName = function (s) { return s.place || ('ALL OF ' + s.zone); };
    var flowText = flows.map(function (fl) {
      return placeName(fl.origin) + ' > ' + fl.dests.map(placeName).join(', ') +
        (fl.mt ? ' | ' + fl.mt + ' MT/month' : '') + (fl.freq ? ' | ' + fl.freq : '') + (fl.note ? ' | ' + fl.note : '');
    }).join('\n');

    var a = {};
    fields.forEach(function (f) {
      var v = f.type === 'flows' ? flowText : p[f.id];
      if (Array.isArray(v)) v = v.join(', ');
      a[f.id] = v == null ? '' : String(v);
    });

    // Web_Responses (columns kept in sync with Form_Config)
    var cols = syncResponseColumns_(ss, readConfig_(ss));
    var row = [];
    for (var c = 0; c < cols.width; c++) row.push('');
    row[0] = now; row[1] = id;
    fields.forEach(function (f) { if (cols.colOf[f.id]) row[cols.colOf[f.id] - 1] = a[f.id]; });
    cols.sheet.appendRow(row);

    // Visit_Lanes: one row per origin > destination
    var FH = ['Submitted At', 'Visit ID', 'Customer', 'Customer Zone', 'Origin #', 'Origin Zone', 'Origin',
      'Destination Zone', 'Destination', 'Origin MT / month', 'Frequency', 'Note'];
    var laneTab = 'Visit_Lanes', vf = ss.getSheetByName(laneTab);
    if (vf && vf.getRange(1, 5).getValue() !== 'Origin #') { laneTab = 'Visit_Lanes_v2'; vf = ss.getSheetByName(laneTab); }   // older layout
    if (!vf) {
      vf = ss.insertSheet(laneTab);
      vf.getRange(1, 1, 1, FH.length).setValues([FH]).setFontWeight('bold').setBackground('#1f3864').setFontColor('#ffffff');
      vf.setFrozenRows(1);
    }
    var legs = [];
    flows.forEach(function (fl, i) {
      fl.dests.forEach(function (d) {
        legs.push([now, id, a.customer || '', a.zone || '', i + 1, fl.origin.zone, placeName(fl.origin),
          d.zone, placeName(d), fl.mt || '', fl.freq || '', fl.note || '']);
      });
    });
    if (legs.length) vf.getRange(vf.getLastRow() + 1, 1, legs.length, FH.length).setValues(legs);

    // Mail + summary
    var rows = fields.map(function (f) { return [f.label, a[f.id]]; });
    var status = sendVisitMail_(ss, a, rows);
    var origins = [], finals = [], finalZones = [];
    var addU = function (arr, v) { if (v && arr.indexOf(v) < 0) arr.push(v); };
    flows.forEach(function (fl) {
      addU(origins, placeName(fl.origin));
      fl.dests.forEach(function (d) { addU(finals, placeName(d)); addU(finalZones, d.zone); });
    });
    var vs = ss.getSheetByName('Visit_Summary');
    if (vs) vs.appendRow([now, a.visitDate || '', a.repName || '', a.repEmail || '', a.customer || '', a.zone || '',
      a.city || '', a.contact || '', a.phone || '', a.commodity || '', a.mValue || '', a.mVolume || '',
      a.potValue || '', origins.join(', '), finalZones.join(', '), finals.join(', '), a.expRate || '',
      status + ' (web ' + id + ')']);
    return { id: id, status: status };
  } finally {
    lock.releaseLock();
  }
}

function sendVisitMail_(ss, a, rows) {
  var settings = readSettings_(ss);
  var rm = findZone_(ss, a.zone || '');
  var to = [settings.COSTING_HEAD_EMAIL, rm.email].filter(String).join(',');
  var cc = [rm.cc, settings.ALWAYS_CC, (String(settings.CC_FIELD_REP).toUpperCase() === 'YES' ? a.repEmail : '')]
    .filter(String).join(',');
  var status;
  if (!to) {
    status = 'NOT SENT - fill COSTING_HEAD_EMAIL in Settings / RM email for ' + a.zone + ' in Zone_Emails';
  } else {
    var subject = 'New Customer Visit: ' + (a.customer || '-') + ' | ' + (a.zone || '-') + ' | Potential Rs ' + (a.potValue || '-') + '/month';
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

/* ------------------------------------------------------------------ admin */

function checkPin_(ss, pin) {
  var real = String(settingsWithDefaults_(ss).ADMIN_PIN || '').trim();
  if (!real) throw new Error('Admin is locked. Put a PIN in Settings > ADMIN_PIN first.');
  if (String(pin || '').trim() !== real) throw new Error('Wrong PIN');
}

/** Everything the admin page shows. Also adds missing master origin zones to Zone_Emails. */
function adminLoad(pin) {
  var ss = responseSheet_();
  checkPin_(ss, pin);
  var masters = getMasters_(ss);
  var ze = ss.getSheetByName('Zone_Emails');
  var have = ze.getDataRange().getValues().slice(1).map(function (r) { return String(r[0]).trim().toUpperCase(); });
  Object.keys(masters.origins).sort().forEach(function (z) {
    if (have.indexOf(z.toUpperCase()) < 0) ze.appendRow([z, '', '', '']);
  });
  var s = settingsWithDefaults_(ss);
  return {
    config: readConfig_(ss),
    zones: ze.getDataRange().getValues().slice(1).filter(function (r) { return String(r[0]).trim(); })
      .map(function (r) { return { zone: String(r[0]), name: String(r[1]), email: String(r[2]), cc: String(r[3]) }; }),
    settings: { COSTING_HEAD_EMAIL: s.COSTING_HEAD_EMAIL || '', ALWAYS_CC: s.ALWAYS_CC || '', CC_FIELD_REP: s.CC_FIELD_REP || 'YES',
      DASHBOARD_MASTER_SHEET: s.DASHBOARD_MASTER_SHEET || '', ORIGIN_ZONE_COLUMN: s.ORIGIN_ZONE_COLUMN, DEST_ZONE_COLUMN: s.DEST_ZONE_COLUMN },
    masters: { source: masters.source, originZones: Object.keys(masters.origins).length,
      origins: countAll_(masters.origins), destZones: Object.keys(masters.dests).length, dests: countAll_(masters.dests) },
    sheetUrl: ss.getUrl()
  };
}

function countAll_(m) { return Object.keys(m).reduce(function (n, k) { return n + m[k].length; }, 0); }

/** Saves all questions. Removed questions stay in Form_Config with Active = NO so old data keeps its column. */
function adminSaveConfig(pin, fields) {
  var ss = responseSheet_();
  checkPin_(ss, pin);
  var old = readConfig_(ss), oldById = {};
  old.forEach(function (f) { oldById[f.id] = f; });
  var seen = {}, rows = [];
  fields.forEach(function (f, i) {
    var id = String(f.id || '').trim() || ('f_' + Date.now().toString(36) + i);
    if (seen[id]) throw new Error('Duplicate question id ' + id);
    seen[id] = 1;
    var o = oldById[id];
    var locked = o ? o.locked : false;
    var type = locked ? o.type : String(f.type);
    if (FIELD_TYPES.indexOf(type) < 0) throw new Error('Unknown type ' + type);
    if ((type === 'flows' || type === 'zone') && !locked) throw new Error('Only one ' + type + ' question is allowed');
    if (!String(f.label || '').trim()) throw new Error('A question has no text');
    var opts = (f.options || []).map(function (s) { return String(s).trim(); }).filter(String);
    if (['single', 'multi', 'dropdown'].indexOf(type) >= 0 && !opts.length) throw new Error('"' + f.label + '" needs at least one option');
    var active = locked ? true : f.active !== false;
    rows.push([id, Number(f.step) || 1, i + 1, String(f.label).trim(), type, f.required ? 'YES' : 'NO', opts.join('\n'),
      String(f.help || ''), active ? 'YES' : 'NO', locked ? 'YES' : 'NO']);
  });
  old.forEach(function (o) {
    if (seen[o.id]) return;
    if (o.locked) throw new Error('"' + o.label + '" cannot be deleted');
    rows.push([o.id, o.step, 999, o.label, o.type, o.required ? 'YES' : 'NO', o.options.join('\n'), o.help, 'NO', 'NO']);
  });
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sh = ss.getSheetByName(CONFIG_SHEET);
    sh.getRange(2, 1, Math.max(sh.getLastRow() - 1, 1), CONFIG_HEADERS.length).clearContent();
    sh.getRange(2, 1, rows.length, CONFIG_HEADERS.length).setValues(rows);
    syncResponseColumns_(ss, readConfig_(ss));
  } finally {
    lock.releaseLock();
  }
  return readConfig_(ss);
}

/** Saves zone emails + mail settings + master link. */
function adminSaveMail(pin, zones, settings) {
  var ss = responseSheet_();
  checkPin_(ss, pin);
  var ze = ss.getSheetByName('Zone_Emails');
  var rows = zones.filter(function (z) { return String(z.zone).trim(); })
    .map(function (z) { return [String(z.zone).trim(), z.name || '', String(z.email || '').trim(), String(z.cc || '').trim()]; });
  ze.getRange(2, 1, Math.max(ze.getLastRow() - 1, 1), 4).clearContent();
  if (rows.length) ze.getRange(2, 1, rows.length, 4).setValues(rows);

  var st = ss.getSheetByName('Settings');
  var data = st.getDataRange().getValues();
  Object.keys(settings).forEach(function (k) {
    if (['COSTING_HEAD_EMAIL', 'ALWAYS_CC', 'CC_FIELD_REP', 'DASHBOARD_MASTER_SHEET', 'ORIGIN_ZONE_COLUMN', 'DEST_ZONE_COLUMN'].indexOf(k) < 0) return;
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][0]).trim() === k) { st.getRange(i + 1, 2).setValue(settings[k]); return; }
    }
    st.appendRow([k, settings[k], '']);
  });
  CacheService.getScriptCache().remove(MASTER_CACHE_KEY);
  return adminLoad(pin);
}

/** Re-reads the dashboard master now (otherwise it refreshes every 10 minutes). */
function adminRefreshMasters(pin) {
  var ss = responseSheet_();
  checkPin_(ss, pin);
  CacheService.getScriptCache().remove(MASTER_CACHE_KEY);
  return adminLoad(pin);
}
