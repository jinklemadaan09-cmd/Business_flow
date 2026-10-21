/**
 * SUGAM GROUP - Customer Visit web app (custom HTML form, admin panel, approvals)
 *
 * Lives in the SAME Apps Script project as Code.gs (setup() must have been run there once).
 * Files in the project: Code.gs, WebApp.gs, Index.html, Admin.html, Approve.html
 *
 * Deploy > New deployment > Web app > Execute as: Me > Who has access: Anyone.
 *   Field reps:  <web app URL>
 *   Admin:       <web app URL>?page=admin   (PIN = ADMIN_PIN in tab Settings)
 *   Approvers:   get their own link in the visit mail (<web app URL>?page=approve&t=<token>)
 *
 * Tabs it uses in the response sheet:
 *   Form_Config    every question (admin edits it from the admin page)
 *   Web_Responses  one row per visit; one column per question, kept in sync with Form_Config
 *   Customer_Lanes one row per customer x origin > destination / delivery point, customer first, with a filter
 *   Visit_Summary  one row per visit, with Costing Head / RM approval, rate and overall status
 *   Approvals      one row per approver per visit (token, status, rate, remark, time)
 *   Mail_Log, Zone_Emails, Settings
 *
 * Zones and places come from the GR PNL data master (tab DASHBOARD_MASTER of the spreadsheet in
 * Settings > GR_MASTER_SHEET): unique Origin Zone > Origin and Destination Zone > Destination >
 * Delivery Point, the same fields the dashboard filters on.
 */

var CONFIG_SHEET = 'Form_Config';
var CONFIG_HEADERS = ['Field_ID', 'Step', 'Order', 'Label', 'Type', 'Required', 'Options', 'Help', 'Active', 'Locked'];
var STEP_NAMES = ['Customer Visit', 'Monthly Business Potential', 'Material Understanding',
  'Origin & Destination Mapping', 'Indicative Rate Discussion'];
var FIELD_TYPES = ['text', 'textarea', 'number', 'money', 'date', 'email', 'tel', 'single', 'multi', 'dropdown', 'zone', 'flows'];
var MASTER_CACHE_KEY = 'visit_masters_v3';
var FLOWS_HELP = 'One block per origin. Tick all its destinations in one go, then add a new block for the next origin.';
var OLD_FLOWS_HELP = 'One card per flow. Add stops in order: origin, then every place the material goes next.';

var SETTING_DEFAULTS = [
  ['GR_MASTER_SHEET', 'https://docs.google.com/spreadsheets/d/1bX6umTLJ88weATME31MhC0SiGRinnLIF9cX9aIMOF2o/edit',
    'GR PNL data master spreadsheet (zones and places for the form)'],
  ['GR_MASTER_TAB', 'DASHBOARD_MASTER', 'Tab in that spreadsheet'],
  ['ADMIN_PIN', '', 'PIN for the admin page (<web app URL>?page=admin). Empty = admin page locked']
];

// Column names accepted in the GR master (compared without spaces, _ or case)
var GR_COLS = {
  originZone: ['originzone', 'orgzone', 'bookingzone'],
  origin: ['origin', 'originname', 'origincity', 'bookingbranch', 'branch'],
  destZone: ['destzone', 'destinationzone', 'dstzone'],
  dest: ['destname', 'destination', 'destinationname', 'destcity'],
  deliveryPoint: ['deliverypoint', 'delpoint', 'deliverypointname', 'dp']
};

var SUMMARY_APPROVAL_HEADERS = ['Visit ID', 'Costing Head Status', 'Costing Head Rate', 'Costing Head Remark', 'Costing Head Time',
  'RM Status', 'RM Rate', 'RM Remark', 'RM Time', 'Overall Status'];
var ROLES = { CH: 'Costing Head', RM: 'Regional Manager' };
var LANE_RATE_HEADERS = { 'Costing Head': 'Costing Head Rate', 'Regional Manager': 'RM Rate' };

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
  var page = (e && e.parameter && e.parameter.page) || '';
  var file = page === 'admin' ? 'Admin' : page === 'approve' ? 'Approve' : 'Index';
  var t = HtmlService.createTemplateFromFile(file);
  var boot;
  if (file === 'Index') {
    var ss = responseSheet_();
    var m = getMasters_(ss);
    boot = { steps: STEP_NAMES, fields: activeFields_(readConfig_(ss)), masters: { origins: m.origins, dests: m.dests } };
  } else if (file === 'Approve') {
    boot = approvalView_(e.parameter.t);
  } else {
    boot = { steps: STEP_NAMES, types: FIELD_TYPES };
  }
  t.boot = JSON.stringify(boot).replace(/</g, '\\u003c');
  return t.evaluate()
    .setTitle(file === 'Admin' ? 'Sugam - Visit Form Admin' : file === 'Approve' ? 'Sugam - Visit Approval' : 'Sugam - Customer Visit')
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

/**
 * Unique places from the GR PNL data master:
 *   origins: { originZone: [origin, ...] }
 *   dests:   { destZone: { destination: [deliveryPoint, ...] } }
 * Cached 10 minutes (split in parts, the cache holds 100 KB per key).
 */
function getMasters_(ss, fresh) {
  var cache = CacheService.getScriptCache();
  if (!fresh) {
    var n = Number(cache.get(MASTER_CACHE_KEY + '_n') || 0);
    if (n) {
      var keys = []; for (var i = 0; i < n; i++) keys.push(MASTER_CACHE_KEY + '_' + i);
      var got = cache.getAll(keys), str = '';
      for (var k = 0; k < n; k++) { if (got[keys[k]] == null) { str = null; break; } str += got[keys[k]]; }
      if (str) return JSON.parse(str);
    }
  }
  var settings = settingsWithDefaults_(ss), m;
  try {
    m = readGrMaster_(settings);
  } catch (err) {
    m = fallbackMasters_();
    m.error = String(err.message || err);
  }
  var json = JSON.stringify(m), parts = {}, size = 90000, count = Math.ceil(json.length / size);
  for (var p = 0; p < count; p++) parts[MASTER_CACHE_KEY + '_' + p] = json.substr(p * size, size);
  parts[MASTER_CACHE_KEY + '_n'] = String(count);
  try { cache.putAll(parts, 600); } catch (err) { /* too big to cache, read next time */ }
  return m;
}

function readGrMaster_(settings) {
  var id = sheetIdFrom_(settings.GR_MASTER_SHEET);
  if (!id) throw new Error('GR_MASTER_SHEET is empty in Settings');
  var file = SpreadsheetApp.openById(id);
  var tab = String(settings.GR_MASTER_TAB || 'DASHBOARD_MASTER').trim();
  var sh = file.getSheetByName(tab);
  if (!sh) throw new Error('Tab ' + tab + ' not found in ' + file.getName());
  var lastRow = sh.getLastRow(), lastCol = sh.getLastColumn();
  if (lastRow < 2) throw new Error('Tab ' + tab + ' is empty');
  var head = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h).toLowerCase().replace(/[^a-z0-9]/g, ''); });
  var col = {}, missing = [];
  Object.keys(GR_COLS).forEach(function (k) {
    var idx = -1;
    GR_COLS[k].some(function (alias) { idx = head.indexOf(alias); return idx >= 0; });
    if (idx < 0 && k !== 'deliveryPoint') missing.push(GR_COLS[k][0]);
    col[k] = idx;
  });
  if (missing.length) throw new Error('Columns not found in ' + tab + ': ' + missing.join(', '));
  var read = function (k) { return col[k] < 0 ? null : sh.getRange(2, col[k] + 1, lastRow - 1, 1).getValues(); };
  var oz = read('originZone'), o = read('origin'), dz = read('destZone'), d = read('dest'), dp = read('deliveryPoint');
  var clean = function (v) { v = String(v == null ? '' : v).trim(); return v && v.toUpperCase() !== 'UNSPECIFIED' ? v : ''; };
  var origins = {}, dests = {}, seenO = {}, seenD = {};
  for (var r = 0; r < lastRow - 1; r++) {
    var z = clean(oz[r][0]), on = clean(o[r][0]);
    if (z && on && !seenO[z + '|' + on]) { seenO[z + '|' + on] = 1; (origins[z] = origins[z] || []).push(on); }
    var z2 = clean(dz[r][0]), dn = clean(d[r][0]), p = dp ? clean(dp[r][0]) : '';
    if (z2 && dn) {
      dests[z2] = dests[z2] || {};
      dests[z2][dn] = dests[z2][dn] || [];
      if (p && p !== dn && !seenD[z2 + '|' + dn + '|' + p]) { seenD[z2 + '|' + dn + '|' + p] = 1; dests[z2][dn].push(p); }
    }
  }
  Object.keys(origins).forEach(function (z) { origins[z].sort(); });
  Object.keys(dests).forEach(function (z) { Object.keys(dests[z]).forEach(function (n) { dests[z][n].sort(); }); });
  return { source: 'GR PNL data master: ' + file.getName() + ' / ' + tab + ' (' + (lastRow - 1) + ' GR rows)', origins: origins, dests: dests };
}

/** Lane master copy inside the script, used only when the GR master cannot be read. */
function fallbackMasters_() {
  var dests = {};
  Object.keys(DEST_BY_ZONE_FALLBACK).forEach(function (z) {
    dests[z] = {};
    DEST_BY_ZONE_FALLBACK[z].forEach(function (n) { dests[z][n] = []; });
  });
  return { source: 'Built-in lane master copy (GR master not readable)', origins: ORIGINS_BY_ZONE, dests: dests };
}

function masterCounts_(m) {
  var c = { originZones: Object.keys(m.origins).length, origins: 0, destZones: Object.keys(m.dests).length, dests: 0, deliveryPoints: 0 };
  Object.keys(m.origins).forEach(function (z) { c.origins += m.origins[z].length; });
  Object.keys(m.dests).forEach(function (z) {
    Object.keys(m.dests[z]).forEach(function (n) { c.dests += 1; c.deliveryPoints += m.dests[z][n].length; });
  });
  return c;
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

function priceOf_(d) { var v = String(d.price == null ? '' : d.price).trim(); return v && !isNaN(Number(v)) ? Number(v) : ''; }

/** Column with this header in a lanes tab, added at the end when missing. */
function laneColumn_(sh, title, color) {
  var head = sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), 1)).getValues()[0];
  var col = head.indexOf(title) + 1;
  if (!col) {
    col = head.length + 1;
    sh.getRange(1, col).setValue(title).setFontWeight('bold').setBackground(color).setFontColor('#ffffff');
  }
  return col;
}

function destName_(d) { return d.dp ? d.place + ' > ' + d.dp : (d.place || 'ALL OF ' + d.zone); }
function originName_(o) { return o.place || ('ALL OF ' + o.zone); }

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
    var flowText = flows.map(function (fl) {
      return originName_(fl.origin) + ' > ' + fl.dests.map(function (d) { return destName_(d) + (priceOf_(d) !== '' ? ' (Rs ' + priceOf_(d) + ')' : ''); }).join(', ') +
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

    // Customer_Lanes: one row per customer x origin > destination / delivery point
    var cl = customerLanesSheet_(ss), lanes = [], n = 0;
    flows.forEach(function (fl, i) {
      fl.dests.forEach(function (d) {
        n++;
        lanes.push([a.customer || '', a.zone || '', id, a.visitDate || '', now, a.repName || '', n + ' of ' + flows.reduce(function (t, x) { return t + x.dests.length; }, 0),
          i + 1, fl.origin.zone, originName_(fl.origin), d.zone, d.place || ('ALL OF ' + d.zone), d.dp || '',
          originName_(fl.origin) + ' > ' + destName_(d), priceOf_(d), fl.mt || '', fl.freq || '', fl.note || '', '', '', 'PENDING']);
      });
    });
    if (lanes.length) cl.getRange(cl.getLastRow() + 1, 1, lanes.length, CL_HEADERS.length).setValues(lanes);

    // Approvals + mail
    var rows = fields.map(function (f) { return [f.label, a[f.id]]; });
    var sent = sendVisitMails_(ss, id, now, a, rows, flows);

    // Visit_Summary
    var origins = [], finals = [], finalZones = [];
    var addU = function (arr, v) { if (v && arr.indexOf(v) < 0) arr.push(v); };
    flows.forEach(function (fl) {
      addU(origins, originName_(fl.origin));
      fl.dests.forEach(function (d) { addU(finals, destName_(d)); addU(finalZones, d.zone); });
    });
    var vs = summarySheet_(ss);
    var base = [now, a.visitDate || '', a.repName || '', a.repEmail || '', a.customer || '', a.zone || '',
      a.city || '', a.contact || '', a.phone || '', a.commodity || '', a.mValue || '', a.mVolume || '',
      a.potValue || '', origins.join(', '), finalZones.join(', '), finals.join(', '), a.expRate || '', sent.status];
    vs.appendRow(base.concat([id, sent.roles.CH ? 'PENDING' : 'NO EMAIL', '', '', '', sent.roles.RM ? 'PENDING' : 'NO EMAIL', '', '', '',
      (sent.roles.CH || sent.roles.RM) ? 'PENDING' : 'NO APPROVER']));
    return { id: id, status: sent.status };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Customer_Lanes: one clean row per customer x lane, customer first, with a filter,
 * so all of one customer's origin > destination splits can be read in one go.
 */
var CL_TAB = 'Customer_Lanes';
var CL_HEADERS = ['Customer', 'Customer Zone', 'Visit ID', 'Visit Date', 'Submitted At', 'Field Rep', 'Lane',
  'Origin #', 'Origin Zone', 'Origin', 'Destination Zone', 'Destination', 'Delivery Point', 'Lane (From > To)',
  'Suggested Price (Field Rep)', 'Origin MT / month', 'Frequency', 'Note', 'Costing Head Rate', 'RM Rate', 'Overall Status'];
var LANE_TABS = [CL_TAB, 'Visit_Lanes', 'Visit_Lanes_v2', 'Visit_Lanes_v3'];   // older tabs are still read for old visits

function customerLanesSheet_(ss) {
  var sh = ss.getSheetByName(CL_TAB);
  if (sh) return sh;
  sh = ss.insertSheet(CL_TAB);
  sh.getRange(1, 1, 1, CL_HEADERS.length).setValues([CL_HEADERS]).setFontWeight('bold').setBackground('#2a3273').setFontColor('#ffffff');
  sh.getRange(1, 15).setBackground('#127a43');
  sh.getRange(1, 19, 1, 2).setBackground('#e9622b');
  sh.setFrozenRows(1);
  sh.setFrozenColumns(1);
  sh.getRange(1, 1, sh.getMaxRows(), CL_HEADERS.length).createFilter();
  return sh;
}

/** Header index helper for any lanes tab. */
function laneCols_(sh) {
  var h = sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), 1)).getValues()[0];
  return function (name) { return h.indexOf(name); };
}

/** Sets Overall Status on every Customer_Lanes row of a visit. */
function setLaneStatus_(ss, id, status) {
  var sh = ss.getSheetByName(CL_TAB); if (!sh || sh.getLastRow() < 2) return;
  var ix = laneCols_(sh), vc = ix('Visit ID'), sc = ix('Overall Status'); if (vc < 0 || sc < 0) return;
  var v = sh.getRange(2, vc + 1, sh.getLastRow() - 1, 1).getValues();
  v.forEach(function (r, k) { if (String(r[0]) === id) sh.getRange(k + 2, sc + 1).setValue(status); });
}

/** Visit_Summary with the approval columns from column 19 on. */
function summarySheet_(ss) {
  var vs = ss.getSheetByName('Visit_Summary');
  var cell = vs.getRange(1, 19);
  if (cell.getValue() !== SUMMARY_APPROVAL_HEADERS[0]) {
    vs.getRange(1, 19, 1, SUMMARY_APPROVAL_HEADERS.length).setValues([SUMMARY_APPROVAL_HEADERS])
      .setFontWeight('bold').setBackground('#2a3273').setFontColor('#ffffff');
  }
  return vs;
}

/* ------------------------------------------------------------------- mail */

/** One mail to the Costing Head and one to the zone RM, each with its own approval link on top. */
function sendVisitMails_(ss, id, now, a, rows, flows) {
  var settings = readSettings_(ss);
  var rm = findZone_(ss, a.zone || '');
  var url = ScriptApp.getService().getUrl();
  var ap = ss.getSheetByName('Approvals');
  var AH = ['Visit ID', 'Submitted At', 'Customer', 'Customer Zone', 'Role', 'Approver Email', 'Token', 'Status',
    'Approved Rate', 'Remark', 'Decided At'];
  if (!ap) {
    ap = ss.insertSheet('Approvals');
    ap.getRange(1, 1, 1, AH.length).setValues([AH]).setFontWeight('bold').setBackground('#2a3273').setFontColor('#ffffff');
    ap.setFrozenRows(1);
  }
  var repCc = String(settings.CC_FIELD_REP).toUpperCase() === 'YES' ? a.repEmail : '';
  var targets = [
    { role: 'CH', to: settings.COSTING_HEAD_EMAIL, cc: [settings.ALWAYS_CC, repCc], name: 'Costing Head' },
    { role: 'RM', to: rm.email, cc: [rm.cc], name: rm.name || 'Regional Manager' }
  ];
  var roles = {}, log = [];
  targets.forEach(function (t) {
    var to = String(t.to || '').trim();
    if (!to) { log.push(ROLES[t.role] + ': no email'); return; }
    var token = Utilities.getUuid().replace(/-/g, '');
    ap.appendRow([id, now, a.customer || '', a.zone || '', ROLES[t.role], to, token, 'PENDING', '', '', '']);
    roles[t.role] = true;
    var link = url + '?page=approve&t=' + token;
    var subject = 'Approval needed: ' + (a.customer || '-') + ' | ' + (a.zone || '-') + ' | Potential Rs ' + (a.potValue || '-') + '/month';
    try {
      var mail = { to: to, subject: subject, htmlBody: visitMailHtml_(ss, id, a, rows, flows, link, t.name, ROLES[t.role]), name: 'Sugam Customer Visit' };
      var cc = t.cc.filter(function (x) { return x && String(x).trim(); }).join(',');
      if (cc) mail.cc = cc;
      if (a.repEmail) mail.replyTo = a.repEmail;
      MailApp.sendEmail(mail);
      log.push(ROLES[t.role] + ': SENT');
      ss.getSheetByName('Mail_Log').appendRow([new Date(), a.customer, a.zone, to + (cc ? ' | cc: ' + cc : ''), 'SENT (' + ROLES[t.role] + ', ' + id + ')']);
    } catch (err) {
      log.push(ROLES[t.role] + ': FAILED ' + err.message);
      ss.getSheetByName('Mail_Log').appendRow([new Date(), a.customer, a.zone, to, 'FAILED: ' + err.message]);
    }
  });
  var status = log.join(' | ');
  if (!roles.CH && !roles.RM) status = 'NOT SENT - fill Costing Head email / RM email for ' + a.zone + ' (Admin > Zone emails)';
  return { status: status, roles: roles };
}

function visitMailHtml_(ss, id, a, rows, flows, link, greetName, roleLabel) {
  var td = 'border:1px solid #dfe4ec;padding:7px 10px;vertical-align:top;font-size:13px;';
  var kv = function (label, v) { return '<td style="padding:4px 18px 4px 0"><div style="font-size:11px;color:#667085">' + label + '</div><div style="font-weight:bold;font-size:14px">' + esc_(v || '-') + '</div></td>'; };
  var laneRows = [];
  flows.forEach(function (fl) {
    fl.dests.forEach(function (d) {
      laneRows.push('<tr><td style="' + td + '">' + esc_(fl.origin.zone) + '</td><td style="' + td + '">' + esc_(originName_(fl.origin)) +
        '</td><td style="' + td + '">' + esc_(d.zone) + '</td><td style="' + td + '">' + esc_(d.place || 'ALL') + '</td><td style="' + td + '">' +
        esc_(d.dp || '') + '</td><td style="' + td + 'font-weight:bold;color:#127a43">' + (priceOf_(d) !== '' ? 'Rs ' + priceOf_(d) : '-') + '</td><td style="' + td + '">' + esc_(fl.mt || '') + '</td><td style="' + td + '">' + esc_(fl.freq || '') + '</td></tr>');
    });
  });
  var th = function (t) { return '<th style="' + td + 'background:#2a3273;color:#fff;text-align:left;font-size:12px">' + t + '</th>'; };
  return '<div style="font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#1b2333;max-width:760px">' +
    '<div style="background:#2a3273;color:#fff;padding:16px 20px;border-radius:10px 10px 0 0;border-bottom:4px solid #e9622b">' +
    '<div style="font-size:11px;letter-spacing:2px;color:#f8ae40;font-weight:bold">SUGAM GROUP &middot; CUSTOMER ONBOARDING JOURNEY</div>' +
    '<div style="font-size:20px;font-weight:bold;margin-top:4px">' + esc_(a.customer) + '</div>' +
    '<div style="opacity:.85">' + esc_(a.city) + ' &middot; Zone ' + esc_(a.zone) + ' &middot; Visit ID ' + esc_(id) + '</div></div>' +
    '<div style="background:#fdf0e9;border:1px solid #f9d5c3;border-top:0;padding:16px 20px">' +
    '<div style="margin-bottom:10px">Dear ' + esc_(greetName) + ', your approval is needed as <b>' + esc_(roleLabel) + '</b>. You can enter an approved rate for each lane.</div>' +
    '<a href="' + link + '" style="display:inline-block;background:#e9622b;color:#fff;text-decoration:none;font-weight:bold;font-size:15px;padding:12px 26px;border-radius:8px">Approve / Reject &amp; enter rate &rarr;</a>' +
    '</div>' +
    '<table style="margin:16px 0 6px"><tr>' + kv('Potential / month', 'Rs ' + (a.potValue || '-')) + kv('Current spend / month', 'Rs ' + (a.mValue || '-')) +
    kv('Volume / month', (a.mVolume || '-') + ' MT') + kv('Expected rate', a.expRate ? 'Rs ' + a.expRate : '-') + '</tr></table>' +
    '<div style="font-weight:bold;color:#e9622b;font-size:12px;letter-spacing:1px;margin:16px 0 6px">ORIGIN &gt; DESTINATION LANES</div>' +
    '<table style="border-collapse:collapse;width:100%"><tr>' + th('Origin zone') + th('Origin') + th('Dest zone') + th('Destination') +  th('Delivery point') + th('Suggested price') + th('MT/month') + th('Frequency') + '</tr>' +
    (laneRows.join('') || '<tr><td colspan="8" style="' + td + '">-</td></tr>') + '</table>' +
    '<div style="font-weight:bold;color:#e9622b;font-size:12px;letter-spacing:1px;margin:18px 0 6px">FULL VISIT DETAILS</div>' +
    '<table style="border-collapse:collapse;width:100%">' +
    rows.filter(function (r) { return r[1]; }).map(function (r, i) {
      return '<tr style="background:' + (i % 2 ? '#ffffff' : '#f4f6fa') + '"><td style="' + td + 'width:240px;font-weight:bold">' + esc_(r[0]) +
        '</td><td style="' + td + '">' + esc_(r[1]).replace(/\n/g, '<br>') + '</td></tr>';
    }).join('') + '</table>' +
    '<p style="margin-top:16px"><a href="' + link + '" style="color:#e9622b;font-weight:bold">Approve / Reject &amp; enter rate</a> &middot; ' +
    '<a href="' + ss.getUrl() + '" style="color:#2a3273">Open response sheet</a></p></div>';
}

/* -------------------------------------------------------------- approvals */

function findApproval_(ss, token) {
  token = String(token || '').trim();
  if (!/^[a-f0-9]{32}$/.test(token)) return null;
  var ap = ss.getSheetByName('Approvals');
  if (!ap) return null;
  var v = ap.getDataRange().getValues();
  for (var i = 1; i < v.length; i++) if (String(v[i][6]) === token) return { sheet: ap, row: i + 1, r: v[i], all: v };
  return null;
}

function summaryRow_(ss, id) {
  var vs = summarySheet_(ss);
  var ids = vs.getRange(1, 19, Math.max(vs.getLastRow(), 1), 1).getValues();
  for (var i = ids.length - 1; i >= 1; i--) if (String(ids[i][0]) === id) return { sheet: vs, row: i + 1 };
  return null;
}

/** Data for the approval page. */
function approvalView_(token) {
  var ss = responseSheet_();
  var f = findApproval_(ss, token);
  if (!f) return { ok: false, error: 'This approval link is not valid.' };
  var id = String(f.r[0]);
  var s = summaryRow_(ss, id), sv = s ? s.sheet.getRange(s.row, 1, 1, 28).getValues()[0] : [];
  var lanes = [], role = String(f.r[4]);
  LANE_TABS.forEach(function (n) {
    var sh = ss.getSheetByName(n); if (!sh) return;
    var v = sh.getDataRange().getValues(), h = v[0];
    var ix = function (name) { return h.indexOf(name); };
    var vid = ix('Visit ID'), sug = ix('Suggested Price (Field Rep)'), mine = ix(LANE_RATE_HEADERS[role]), other = ix(LANE_RATE_HEADERS[role === ROLES.CH ? ROLES.RM : ROLES.CH]);
    if (vid < 0) return;
    v.forEach(function (r, i) {
      if (i === 0 || String(r[vid]) !== id) return;
      lanes.push({ tab: n, row: i + 1, oz: r[ix('Origin Zone')], o: r[ix('Origin')], dz: r[ix('Destination Zone')], d: r[ix('Destination')],
        dp: ix('Delivery Point') >= 0 ? r[ix('Delivery Point')] : '', mt: r[ix('Origin MT / month')], fq: r[ix('Frequency')],
        rate: mine >= 0 ? r[mine] : '', otherRate: other >= 0 ? r[other] : '', suggested: sug >= 0 ? r[sug] : '' });
    });
  });
  var others = f.all.slice(1).filter(function (r) { return String(r[0]) === id && String(r[6]) !== String(token); })
    .map(function (r) { return { role: r[4], status: r[7], rate: r[8], remark: r[9] }; });
  var fmt = function (d) { return d instanceof Date ? Utilities.formatDate(d, Session.getScriptTimeZone(), 'dd MMM yyyy, HH:mm') : String(d || ''); };
  return {
    ok: true, token: token, id: id, role: f.r[4], email: f.r[5], status: f.r[7], rate: f.r[8], remark: f.r[9], decidedAt: fmt(f.r[10]),
    visit: { customer: f.r[2], zone: f.r[3], submitted: fmt(f.r[1]), rep: sv[2] || '', city: sv[6] || '', commodity: sv[9] || '',
      mValue: sv[10] || '', mVolume: sv[11] || '', potValue: sv[12] || '', expRate: sv[16] || '' },
    lanes: lanes, others: others
  };
}

/**
 * Called from the approval page. decision = APPROVED | REJECTED.
 * rates = [{ tab, row, rate }] one optional rate per lane (origin > destination / delivery point).
 */
function approveSave(token, decision, rates, remark) {
  if (['APPROVED', 'REJECTED'].indexOf(decision) < 0) throw new Error('Choose Approve or Reject');
  rates = Array.isArray(rates) ? rates : [];
  rates.forEach(function (x) {
    x.rate = String(x.rate == null ? '' : x.rate).trim();
    if (x.rate && isNaN(Number(x.rate))) throw new Error('Rates must be numbers');
  });
  var ss = responseSheet_();
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var f = findApproval_(ss, token);
    if (!f) throw new Error('This approval link is not valid.');
    var now = new Date(), id = String(f.r[0]), role = String(f.r[4]);

    // per-lane rate into the lanes tab (only rows of this visit)
    var summary = [];
    rates.forEach(function (x) {
      if (LANE_TABS.indexOf(x.tab) < 0) return;
      var sh = ss.getSheetByName(x.tab); if (!sh) return;
      var ix = laneCols_(sh), row = Number(x.row);
      if (!(row >= 2) || ix('Visit ID') < 0 || String(sh.getRange(row, ix('Visit ID') + 1).getValue()) !== id) return;
      var col = laneColumn_(sh, LANE_RATE_HEADERS[role], '#e9622b');
      sh.getRange(row, col).setValue(x.rate ? Number(x.rate) : '');
      if (x.rate) {
        var lr = sh.getRange(row, 1, 1, sh.getLastColumn()).getValues()[0], dp = lr[ix('Delivery Point')];
        summary.push(lr[ix('Origin')] + ' > ' + lr[ix('Destination')] + (dp ? ' > ' + dp : '') + ': ' + x.rate);
      }
    });
    var rateText = summary.join('; ');
    f.sheet.getRange(f.row, 8, 1, 4).setValues([[decision, rateText, String(remark || '').trim(), now]]);

    var all = f.sheet.getDataRange().getValues().slice(1).filter(function (r) { return String(r[0]) === id; });
    var overall = all.some(function (r) { return r[7] === 'REJECTED'; }) ? 'REJECTED'
      : all.every(function (r) { return r[7] === 'APPROVED'; }) ? 'APPROVED' : 'PENDING';

    var s = summaryRow_(ss, id);
    if (s) {
      var off = role === ROLES.CH ? 20 : 24;   // Costing Head cols 20-23, RM cols 24-27
      s.sheet.getRange(s.row, off, 1, 4).setValues([[decision, rateText, String(remark || '').trim(), now]]);
      var oldOverall = s.sheet.getRange(s.row, 28).getValue();
      s.sheet.getRange(s.row, 28).setValue(overall);
      setLaneStatus_(ss, id, overall);
      if (overall !== 'PENDING' && overall !== oldOverall) notifyRep_(ss, s, id, overall, all);
    }
    return approvalView_(token);
  } finally {
    lock.releaseLock();
  }
}

/** Tells the field rep the final outcome. */
function notifyRep_(ss, s, id, overall, all) {
  var sv = s.sheet.getRange(s.row, 1, 1, 18).getValues()[0];
  var rep = String(sv[3] || '').trim();
  if (!rep) return;
  var color = overall === 'APPROVED' ? '#127a43' : '#c62f3b';
  var html = '<div style="font-family:Arial;font-size:13px;color:#1b2333;max-width:640px">' +
    '<div style="background:#2a3273;color:#fff;padding:14px 18px;border-radius:10px 10px 0 0;border-bottom:4px solid #e9622b">' +
    '<div style="font-size:11px;letter-spacing:2px;color:#f8ae40;font-weight:bold">SUGAM GROUP &middot; CUSTOMER ONBOARDING JOURNEY</div>' +
    '<div style="font-size:18px;font-weight:bold">' + esc_(sv[4]) + ': <span style="color:' + (overall === 'APPROVED' ? '#7fe0a8' : '#ff9aa2') + '">' + overall + '</span></div></div>' +
    '<p>Hi ' + esc_(sv[2]) + ', the visit ' + esc_(id) + ' is <b style="color:' + color + '">' + overall.toLowerCase() + '</b>.</p>' +
    '<table style="border-collapse:collapse">' + all.map(function (r) {
      return '<tr><td style="border:1px solid #dfe4ec;padding:6px 10px;font-weight:bold">' + esc_(r[4]) + '</td><td style="border:1px solid #dfe4ec;padding:6px 10px">' +
        esc_(r[7]) + (r[8] !== '' ? '<br>Rates: ' + esc_(String(r[8]).replace(/; /g, ' | ')) : '') + (r[9] ? '<br>' + esc_(r[9]) : '') + '</td></tr>';
    }).join('') + '</table></div>';
  try {
    MailApp.sendEmail({ to: rep, subject: 'Visit ' + overall.toLowerCase() + ': ' + sv[4] + ' | ' + sv[5], htmlBody: html, name: 'Sugam Customer Visit' });
    ss.getSheetByName('Mail_Log').appendRow([new Date(), sv[4], sv[5], rep, 'SENT (field rep, ' + overall + ', ' + id + ')']);
  } catch (err) {
    ss.getSheetByName('Mail_Log').appendRow([new Date(), sv[4], sv[5], rep, 'FAILED: ' + err.message]);
  }
}

/* ------------------------------------------------------------------ admin */

function checkPin_(ss, pin) {
  var real = String(settingsWithDefaults_(ss).ADMIN_PIN || '').trim();
  if (!real) throw new Error('Admin is locked. Put a PIN in Settings > ADMIN_PIN first.');
  if (String(pin || '').trim() !== real) throw new Error('Wrong PIN');
}

/** Everything the admin page shows. Also adds missing master origin zones to Zone_Emails. */
function adminLoad(pin, fresh) {
  var ss = responseSheet_();
  checkPin_(ss, pin);
  var masters = getMasters_(ss, fresh);
  var ze = ss.getSheetByName('Zone_Emails');
  var have = ze.getDataRange().getValues().slice(1).map(function (r) { return String(r[0]).trim().toUpperCase(); });
  Object.keys(masters.origins).sort().forEach(function (z) {
    if (have.indexOf(z.toUpperCase()) < 0) ze.appendRow([z, '', '', '']);
  });
  var s = settingsWithDefaults_(ss);
  var c = masterCounts_(masters);
  c.source = masters.source; c.error = masters.error || '';
  return {
    config: readConfig_(ss),
    zones: ze.getDataRange().getValues().slice(1).filter(function (r) { return String(r[0]).trim(); })
      .map(function (r) { return { zone: String(r[0]), name: String(r[1]), email: String(r[2]), cc: String(r[3]) }; }),
    settings: { COSTING_HEAD_EMAIL: s.COSTING_HEAD_EMAIL || '', ALWAYS_CC: s.ALWAYS_CC || '', CC_FIELD_REP: s.CC_FIELD_REP || 'YES',
      GR_MASTER_SHEET: s.GR_MASTER_SHEET || '', GR_MASTER_TAB: s.GR_MASTER_TAB || 'DASHBOARD_MASTER' },
    masters: c,
    sheetUrl: ss.getUrl()
  };
}

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

/** Saves zone emails + mail settings + GR master link. */
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
    if (['COSTING_HEAD_EMAIL', 'ALWAYS_CC', 'CC_FIELD_REP', 'GR_MASTER_SHEET', 'GR_MASTER_TAB'].indexOf(k) < 0) return;
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][0]).trim() === k) { st.getRange(i + 1, 2).setValue(settings[k]); return; }
    }
    st.appendRow([k, settings[k], '']);
  });
  return adminLoad(pin, true);
}

/** Re-reads the GR master now (otherwise it refreshes every 10 minutes). */
function adminRefreshMasters(pin) {
  return adminLoad(pin, true);
}
