/**
 * SUGAM GROUP - Customer Visit web app (custom HTML form, admin panel, two-level approval)
 *
 * Lives in the SAME Apps Script project as Code.gs (setup() must have been run there once).
 * Files in the project: Code.gs, WebApp.gs, Index.html, Admin.html, Approve.html, Tracker.html
 *
 * Deploy > New deployment > Web app > Execute as: Me > Who has access: Anyone.
 *   Field reps:    <web app URL>
 *   Admin:         <web app URL>?page=admin            (PIN = ADMIN_PIN in tab Settings)
 *   Approvals:     <web app URL>?page=approve&t=<token> (link in the digest mail; RM, Head Costing and field rep each have their own)
 *   Head Costing:  <web app URL>?page=tracker&k=<TRACKER_KEY> (all visits with stage filters)
 *
 * Flow: field rep submits > Regional Manager of the customer zone (per lane approve / reject + RM rate)
 *   > Head Costing (per lane approve / reject + HO approved rate) > HO rates go into Web_Responses and
 *   the field rep gets a mail > field rep revisits the customer and sets Finalized / Pending at customer / Customer refused.
 *   RM and Head Costing get a digest mail at the times in Settings > DIGEST_TIMES (default 2:00 pm and 5:00 pm).
 *
 * Tabs it uses in the response sheet:
 *   Form_Config    every question (admin edits it from the admin page)
 *   Web_Responses  one row per visit; one column per question + stage / RM / HO / outcome columns
 *   Customer_Lanes one row per customer x origin > destination / delivery point, with RM and HO decision and rate
 *   Visit_Tracker  one row per visit: stage, due date, RM / HO / outcome details and the links' tokens
 *   Mail_Log, Zone_Emails, Settings
 */

var APP_VERSION = 'v3.10 (22 Oct 2026)';   // shown on the form and admin page, to check the deployed version
var CONFIG_SHEET = 'Form_Config';
var CONFIG_HEADERS = ['Field_ID', 'Step', 'Order', 'Label', 'Type', 'Required', 'Options', 'Help', 'Active', 'Locked'];
var STEP_NAMES = ['Customer Visit', 'Monthly Business Potential', 'Material Understanding',
  'Origin & Destination Mapping', 'Indicative Rate Discussion'];
var FIELD_TYPES = ['text', 'textarea', 'number', 'money', 'date', 'email', 'tel', 'single', 'multi', 'dropdown', 'zone', 'flows'];
var MASTER_CACHE_KEY = 'visit_masters_v7';
var FLOWS_HELP = 'One block per origin. Tick all its destinations in one go, then add a new block for the next origin.';
var OLD_FLOWS_HELP = 'One card per flow. Add stops in order: origin, then every place the material goes next.';

var SETTING_DEFAULTS = [
  ['GR_MASTER_SHEET', 'https://docs.google.com/spreadsheets/d/1bX6umTLJ88weATME31MhC0SiGRinnLIF9cX9aIMOF2o/edit',
    'GR PNL data master spreadsheet (zones and places for the form)'],
  ['GR_MASTER_TAB', 'DASHBOARD_MASTER', 'Tab in that spreadsheet'],
  ['ADMIN_PIN', '', 'PIN for the admin page (<web app URL>?page=admin). Empty = admin page locked'],
  ['COSTING_HEAD_EMAIL', '', 'Head Costing email (second approval level, gets the Head Costing digest)'],
  ['DIGEST_ON', 'YES', 'YES = send the digest mails at DIGEST_TIMES'],
  ['INSTANT_MAIL', 'YES', 'YES = also mail the RM / Head Costing the moment a visit reaches them (useful while testing)'],
  ['DIGEST_TIMES', '14:00, 17:00', 'Digest mail times (24h, comma separated). Google sends within that hour'],
  ['TAT_RM_DAYS', '2', 'Days the Regional Manager has to decide'],
  ['TAT_HO_DAYS', '2', 'Days Head Costing has to decide'],
  ['TAT_FR_DAYS', '2', 'Days the field rep has to set the customer outcome'],
  ['TRACKER_KEY', '', 'Key in the Head Costing tracker link. Filled automatically; change it to stop old links']
];

// Column names accepted in the GR master (compared without spaces, _ or case)
var GR_COLS = {
  originZone: ['originzone', 'orgzone', 'bookingzone'],
  origin: ['origin', 'originname', 'origincity', 'bookingbranch', 'branch'],
  destZone: ['destzone', 'destinationzone', 'dstzone'],
  dest: ['destname', 'destination', 'destinationname', 'destcity'],
  deliveryPoint: ['deliverypoint', 'delpoint', 'deliverypointname', 'dp']
};
var GR_OPTIONAL = ['deliveryPoint'];

// Field_ID, Step, Label, Type, Required, Options (one per line), Help, Locked
var DEFAULT_FIELDS = [
  ['repName', 1, 'Your name', 'text', 1, '', '', 1],
  ['repId', 1, 'Employee ID', 'text', 1, '', '', 1],
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
  var file = page === 'admin' ? 'Admin' : page === 'approve' ? 'Approve' : page === 'tracker' ? 'Tracker' : 'Index';
  var t = HtmlService.createTemplateFromFile(file);
  var boot;
  if (file === 'Index') {
    var ss = responseSheet_();
    var m = getMasters_(ss);
    boot = { steps: STEP_NAMES, fields: activeFields_(readConfig_(ss)), masters: { origins: m.origins, dests: m.dests }, zones: customerZones_(ss), version: APP_VERSION };
  } else if (file === 'Approve') {
    boot = approvalView_(e.parameter.t);
  } else if (file === 'Tracker') {
    boot = trackerView_(e.parameter.k);
  } else {
    boot = { steps: STEP_NAMES, types: FIELD_TYPES, version: APP_VERSION };
  }
  t.boot = JSON.stringify(boot).replace(/</g, '\\u003c');
  return t.evaluate()
    .setTitle({ Admin: 'Sugam - Visit Form Admin', Approve: 'Sugam - Visit Approval', Tracker: 'Sugam - Visit Tracker' }[file] || 'Sugam - Customer Visit')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function responseSheet_() {
  return SpreadsheetApp.openById(PropertiesService.getScriptProperties().getProperty('SHEET_ID'));
}

/* ----------------------------------------------------------------- config */

/** Only these questions are core (cannot be deleted or change type): the zone decides the RM, the lanes carry the prices. */
var LOCKED_FIELDS = ['zone', 'flows'];

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
  if (!vals.some(function (r) { return String(r[0]).trim() === 'repId'; })) {   // one-time: Employee ID after the rep name
    var er = ['repId', 1, 1.5, 'Employee ID', 'text', 'YES', '', '', 'YES', 'YES'];
    sh.appendRow(er); vals.push(er);
  }
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
      help: String(r[7] || ''), active: yes_(r[8]), locked: LOCKED_FIELDS.indexOf(String(r[0]).trim()) >= 0
    };
  }).sort(function (a, b) { return a.step - b.step || a.order - b.order; });
}

function activeFields_(config) { return config.filter(function (f) { return f.active; }); }
function yes_(v) { return /^(yes|y|true|1)$/i.test(String(v).trim()); }

/* ---------------------------------------------------------------- masters */

/**
 * Zones and places for the form, fast: script cache (6 h) > saved copy in the hidden tab Master_Cache >
 * live read of the GR master (slow, big sheet). The hourly trigger runMasterRefresh keeps the copy fresh,
 * so a field rep never waits for the live read. fresh = read the GR master now (Admin > Reload master now).
 */
var MASTER_TAB = 'Master_Cache';
var MASTER_CELL = 45000;   // characters per cell (a cell holds up to 50,000)

function getMasters_(ss, fresh) {
  if (!fresh) {
    var hit = masterFromCache_();
    if (hit) return hit;
    var saved = masterFromTab_(ss);
    if (saved) { masterToCache_(saved.json); return saved.m; }
  }
  var settings = settingsWithDefaults_(ss), m;
  try {
    m = readGrMaster_(settings);
  } catch (err) {
    m = fallbackMasters_();
    m.error = String(err.message || err);
  }
  m.readAt = new Date().toISOString();
  var json = JSON.stringify(m);
  masterToCache_(json);
  if (!m.error) masterToTab_(ss, json);
  return m;
}

function masterFromCache_() {
  var cache = CacheService.getScriptCache(), n = Number(cache.get(MASTER_CACHE_KEY + '_n') || 0);
  if (!n) return null;
  var keys = []; for (var i = 0; i < n; i++) keys.push(MASTER_CACHE_KEY + '_' + i);
  var got = cache.getAll(keys), str = '';
  for (var k = 0; k < n; k++) { if (got[keys[k]] == null) return null; str += got[keys[k]]; }
  return JSON.parse(str);
}

function masterToCache_(json) {
  var parts = {}, size = 90000, count = Math.ceil(json.length / size);
  for (var p = 0; p < count; p++) parts[MASTER_CACHE_KEY + '_' + p] = json.substr(p * size, size);
  parts[MASTER_CACHE_KEY + '_n'] = String(count);
  try { CacheService.getScriptCache().putAll(parts, 21600); } catch (err) { /* too big for the cache; the tab copy is used */ }
}

function masterFromTab_(ss) {
  var sh = ss.getSheetByName(MASTER_TAB);
  if (!sh || sh.getLastRow() < 2) return null;
  var v = sh.getRange(1, 1, sh.getLastRow(), 1).getValues(), json = '';
  for (var i = 1; i < v.length; i++) json += String(v[i][0]);
  try { return { m: JSON.parse(json), json: json }; } catch (err) { return null; }
}

function masterToTab_(ss, json) {
  var sh = ss.getSheetByName(MASTER_TAB);
  if (!sh) { sh = ss.insertSheet(MASTER_TAB); sh.hideSheet(); }
  var rows = [['Copy of the GR master zones and places for the form. Written automatically, do not edit. Updated ' + new Date()]];
  for (var p = 0; p < json.length; p += MASTER_CELL) rows.push([json.substr(p, MASTER_CELL)]);
  sh.clearContents();
  sh.getRange(1, 1, rows.length, 1).setValues(rows);
}

/** Hourly trigger: re-reads the GR master in the background so the form always opens fast. */
function runMasterRefresh(e) {
  if (!e || !e.triggerUid) return;
  getMasters_(responseSheet_(), true);
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
    if (idx < 0 && GR_OPTIONAL.indexOf(k) < 0) missing.push(GR_COLS[k][0]);
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

    // First approval level: RM of the customer zone (Head Costing straight away if the zone has no RM email)
    var settings = settingsWithDefaults_(ss), rm = findZone_(ss, a.zone || '');
    var stage = rm.email ? STAGE.RM : STAGE.HO;
    var due = addDays_(now, tat_(settings, rm.email ? 'RM' : 'HO'));

    // Customer_Lanes: one row per customer x origin > destination / delivery point
    var total = flows.reduce(function (t, x) { return t + x.dests.length; }, 0), lanes = [], n = 0;
    flows.forEach(function (fl, i) {
      fl.dests.forEach(function (d) {
        n++;
        lanes.push({ 'Customer': a.customer || '', 'Customer Zone': a.zone || '', 'Visit ID': id, 'Visit Date': a.visitDate || '', 'Submitted At': now,
          'Field Rep': a.repName || '', 'Employee ID': a.repId || '', 'Lane': n + ' of ' + total, 'Origin #': i + 1, 'Origin Zone': fl.origin.zone,
          'Origin': originName_(fl.origin), 'Destination Zone': d.zone, 'Destination': d.place || ('ALL OF ' + d.zone), 'Delivery Point': d.dp || '',
          'Lane (From > To)': originName_(fl.origin) + ' > ' + destName_(d), 'Suggested Price (Field Rep)': priceOf_(d),
          'Origin MT / month': fl.mt || '', 'Frequency': fl.freq || '', 'Note': fl.note || '', 'Lane Status': stage, 'Stage': stage });
      });
    });
    writeLanes_(customerLanesSheet_(ss), lanes);

    // Visit_Tracker: stage, due date and one link token per person
    var tok = function () { return Utilities.getUuid().replace(/-/g, ''); };
    appendTracker_(ss, { 'Visit ID': id, 'Submitted At': now, 'Visit Date': a.visitDate || '', 'Field Rep': a.repName || '',
      'Employee ID': a.repId || '', 'Rep Email': a.repEmail || '', 'Customer': a.customer || '', 'Customer Zone': a.zone || '',
      'City': a.city || '', 'Potential / month': a.potValue || '', 'Lanes': total, 'Stage': stage, 'Stage Since': now, 'Due By': due,
      'RM Email': rm.email, 'RM Status': rm.email ? 'PENDING' : 'NO RM EMAIL', 'HO Status': 'PENDING',
      'RM Token': tok(), 'HO Token': tok(), 'FR Token': tok() });
    writeResponseStatus_(ss, id, { 'Stage': stage });
    mailLog_(ss).appendRow([now, a.customer, a.zone, '', 'NEW VISIT ' + id + ' > ' + stage + (rm.email ? ' (RM ' + rm.email + ')' : ' (no RM email found for zone "' + (a.zone || '') + '" in Zone_Emails)')]);
    var instant = isInstant_(settings);
    if (instant) mailApprover_(ss, trackerRows_(ss).filter(function (x) { return String(x['Visit ID']) === id; })[0], rm.email ? 'RM' : 'HO');
    refreshAllData_(ss);
    return { id: id, status: stage + '. ' + (rm.email ? 'The Regional Manager (' + rm.email + ')' : 'Head Costing (no RM email for ' + (a.zone || 'this zone') + ')') +
      (instant ? ' has been mailed now.' : ' gets it in the next digest mail.') };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Customer_Lanes: one clean row per customer x lane, customer first, with a filter,
 * so all of one customer's origin > destination splits can be read in one go.
 */
var CL_TAB = 'Customer_Lanes';
var CL_HEADERS = ['Customer', 'Customer Zone', 'Visit ID', 'Visit Date', 'Submitted At', 'Field Rep', 'Employee ID', 'Lane',
  'Origin #', 'Origin Zone', 'Origin', 'Destination Zone', 'Destination', 'Delivery Point', 'Lane (From > To)',
  'Suggested Price (Field Rep)', 'Origin MT / month', 'Frequency', 'Note',
  'RM Decision', 'RM Rate', 'HO Decision', 'HO Approved Rate', 'Final Rate', 'Lane Status', 'Stage'];
var CL_COLORS = { 'Suggested Price (Field Rep)': '#127a43', 'RM Decision': '#e9622b', 'RM Rate': '#e9622b',
  'HO Decision': '#c62f3b', 'HO Approved Rate': '#c62f3b', 'Final Rate': '#127a43' };
var LANE_TABS = [CL_TAB, 'Visit_Lanes', 'Visit_Lanes_v2', 'Visit_Lanes_v3'];   // older tabs are still read for old visits

function customerLanesSheet_(ss) {
  var sh = ss.getSheetByName(CL_TAB);
  if (sh) { dropOldLaneColumns_(sh); return sh; }
  sh = ss.insertSheet(CL_TAB);
  sh.getRange(1, 1, 1, CL_HEADERS.length).setValues([CL_HEADERS]).setFontWeight('bold').setBackground('#2a3273').setFontColor('#ffffff');
  CL_HEADERS.forEach(function (h, i) { if (CL_COLORS[h]) sh.getRange(1, i + 1).setBackground(CL_COLORS[h]); });
  sh.setFrozenRows(1);
  sh.setFrozenColumns(1);
  sh.getRange(1, 1, sh.getMaxRows(), CL_HEADERS.length).createFilter();
  return sh;
}

/** Card rate and via border were removed from the form: drop their old columns from Customer_Lanes. */
function dropOldLaneColumns_(sh) {
  var head = sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), 1)).getValues()[0];
  for (var i = head.length - 1; i >= 0; i--) {
    if (['Card Rate', 'Via Border', 'CH Decision', 'Costing Head Rate', 'Overall Status'].indexOf(String(head[i])) >= 0) sh.deleteColumn(i + 1);
  }
}

/** Appends lane rows by header name; columns missing in an older tab are added at the end. */
function writeLanes_(sh, objs) {
  if (!objs.length) return;
  var head = sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), 1)).getValues()[0];
  CL_HEADERS.forEach(function (h) {
    if (head.indexOf(h) >= 0) return;
    head.push(h);
    sh.getRange(1, head.length).setValue(h).setFontWeight('bold').setBackground(CL_COLORS[h] || '#2a3273').setFontColor('#ffffff');
  });
  var rows = objs.map(function (o) { return head.map(function (h) { return o[h] === undefined ? '' : o[h]; }); });
  sh.getRange(sh.getLastRow() + 1, 1, rows.length, head.length).setValues(rows);
}

/** Every lane of one visit, from Customer_Lanes (and the older lane tabs). */
function visitLanes_(ss, id) {
  var lanes = [];
  LANE_TABS.forEach(function (n) {
    var sh = ss.getSheetByName(n); if (!sh) return;
    var v = sh.getDataRange().getValues(), h = v[0];
    var ix = function (name) { return h.indexOf(name); };
    var get = function (r, name) { return ix(name) >= 0 ? r[ix(name)] : ''; };
    if (ix('Visit ID') < 0) return;
    v.forEach(function (r, i) {
      if (i === 0 || String(r[ix('Visit ID')]) !== id) return;
      lanes.push({ tab: n, row: i + 1, oz: get(r, 'Origin Zone'), o: get(r, 'Origin'), dz: get(r, 'Destination Zone'), d: get(r, 'Destination'),
        dp: get(r, 'Delivery Point'), mt: get(r, 'Origin MT / month'), fq: get(r, 'Frequency'), suggested: get(r, 'Suggested Price (Field Rep)'),
        rmDec: get(r, 'RM Decision'), rmRate: get(r, 'RM Rate'), hoDec: get(r, 'HO Decision'), hoRate: get(r, 'HO Approved Rate'),
        finalRate: get(r, 'Final Rate'), status: get(r, 'Lane Status') });
    });
  });
  return lanes;
}

/** Writes some columns of one lane row (columns are added when missing). */
function setLane_(ss, lane, obj) {
  var sh = ss.getSheetByName(lane.tab);
  Object.keys(obj).forEach(function (k) { sh.getRange(lane.row, laneColumn_(sh, k, CL_COLORS[k] || '#2a3273')).setValue(obj[k]); });
}

/** Stage on every lane row of a visit. */
function setLanesStage_(ss, id, stage) {
  var sh = ss.getSheetByName(CL_TAB); if (!sh || sh.getLastRow() < 2) return;
  var col = laneColumn_(sh, 'Stage', '#2a3273');
  var h = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0], vc = h.indexOf('Visit ID');
  if (vc < 0) return;
  sh.getRange(2, vc + 1, sh.getLastRow() - 1, 1).getValues().forEach(function (r, k) {
    if (String(r[0]) === id) sh.getRange(k + 2, col).setValue(stage);
  });
}

function laneName_(l) { return l.o + ' > ' + l.d + (l.dp ? ' > ' + l.dp : ''); }
function num_(v) { v = String(v == null ? '' : v).trim(); return v === '' ? '' : Number(v); }

/* --------------------------------------------------------------- tracker */

var TRACKER_TAB = 'Visit_Tracker';
var TR_HEADERS = ['Visit ID', 'Submitted At', 'Visit Date', 'Field Rep', 'Employee ID', 'Rep Email', 'Customer', 'Customer Zone', 'City',
  'Potential / month', 'Lanes', 'Stage', 'Stage Since', 'Due By', 'RM Email', 'RM Status', 'RM Remark', 'RM At',
  'HO Status', 'HO Approved Rates', 'HO Remark', 'HO At', 'Outcome', 'Outcome Remark', 'Outcome At', 'RM Token', 'HO Token', 'FR Token'];
var STAGE = { RM: 'Pending at RM', RM_REJ: 'Rejected by RM', HO: 'Pending at Head Costing', HO_REJ: 'Rejected by Head Costing',
  FR: 'Pending at Field Rep', CUST: 'Pending at Customer', REFUSED: 'Customer Refused', FINAL: 'Finalized' };
var OUTCOMES = { FINALIZED: STAGE.FINAL, PENDING_CUSTOMER: STAGE.CUST, REFUSED: STAGE.REFUSED };
var TOKEN_COLS = { RM: 'RM Token', HO: 'HO Token', FR: 'FR Token' };

function trackerSheet_(ss) {
  var sh = ss.getSheetByName(TRACKER_TAB);
  if (sh) return sh;
  sh = ss.insertSheet(TRACKER_TAB);
  sh.getRange(1, 1, 1, TR_HEADERS.length).setValues([TR_HEADERS]).setFontWeight('bold').setBackground('#2a3273').setFontColor('#ffffff');
  sh.getRange(1, TR_HEADERS.indexOf('Stage') + 1, 1, 3).setBackground('#e9622b');
  sh.setFrozenRows(1);
  sh.setFrozenColumns(1);
  sh.getRange(1, 1, sh.getMaxRows(), TR_HEADERS.length).createFilter();
  return sh;
}

function appendTracker_(ss, obj) {
  var sh = trackerSheet_(ss);
  sh.getRange(sh.getLastRow() + 1, 1, 1, TR_HEADERS.length).setValues([TR_HEADERS.map(function (h) { return obj[h] === undefined ? '' : obj[h]; })]);
}

/** All tracker rows as objects (newest first). */
function trackerRows_(ss) {
  var sh = trackerSheet_(ss), v = sh.getDataRange().getValues(), h = v[0];
  return v.slice(1).map(function (r, i) {
    var o = { _row: i + 2 };
    h.forEach(function (k, j) { o[k] = r[j]; });
    return o;
  }).filter(function (o) { return o['Visit ID']; }).reverse();
}

/** The tracker row whose RM / HO / FR token matches, with its role. */
function trackerByToken_(ss, token) {
  token = String(token || '').trim();
  if (!/^[a-f0-9]{32}$/.test(token)) return null;
  var rows = trackerRows_(ss);
  for (var i = 0; i < rows.length; i++) {
    for (var role in TOKEN_COLS) if (String(rows[i][TOKEN_COLS[role]]) === token) return { t: rows[i], role: role };
  }
  return null;
}

/** Updates some columns of a tracker row in one write. */
function updateTracker_(ss, t, obj) {
  var sh = trackerSheet_(ss);
  Object.keys(obj).forEach(function (k) { t[k] = obj[k]; });
  sh.getRange(t._row, 1, 1, TR_HEADERS.length).setValues([TR_HEADERS.map(function (h) { return t[h] === undefined ? '' : t[h]; })]);
}

/**
 * Stage / RM / HO / outcome columns at the end of Web_Responses, filled on the visit's own row.
 * They carry the note "sys:<name>" so the question columns sync never touches them.
 */
function writeResponseStatus_(ss, id, obj) {
  var sh = ss.getSheetByName('Web_Responses'); if (!sh) return;
  var lastCol = Math.max(sh.getLastColumn(), 2), colOf = {};
  sh.getRange(1, 1, 1, lastCol).getNotes()[0].forEach(function (n, i) { var m = String(n).match(/^sys:(.+)$/); if (m) colOf[m[1]] = i + 1; });
  var ids = sh.getRange(1, 2, Math.max(sh.getLastRow(), 1), 1).getValues(), row = 0;
  for (var i = ids.length - 1; i >= 1; i--) if (String(ids[i][0]) === id) { row = i + 1; break; }
  if (!row) return;
  Object.keys(obj).forEach(function (k) {
    if (!colOf[k]) {
      lastCol += 1;
      if (lastCol > sh.getMaxColumns()) sh.insertColumnAfter(sh.getMaxColumns());
      sh.getRange(1, lastCol).setValue(k).setNote('sys:' + k).setFontWeight('bold').setBackground(/^HO/.test(k) ? '#c62f3b' : '#e9622b').setFontColor('#ffffff');
      colOf[k] = lastCol;
    }
    sh.getRange(row, colOf[k]).setValue(obj[k]);
  });
}

/** A visit's answers by question id, read from Web_Responses. */
function responseValues_(ss, id) {
  var sh = ss.getSheetByName('Web_Responses'), out = {};
  if (!sh || sh.getLastRow() < 2) return out;
  var lastCol = sh.getLastColumn(), notes = sh.getRange(1, 1, 1, lastCol).getNotes()[0];
  var v = sh.getRange(1, 1, sh.getLastRow(), lastCol).getValues();
  for (var i = v.length - 1; i >= 1; i--) {
    if (String(v[i][1]) !== id) continue;
    notes.forEach(function (n, j) { var m = String(n).match(/^fid:(.+)$/); if (m) out[m[1]] = v[i][j]; });
    break;
  }
  return out;
}

function tat_(settings, role) { var n = Number(settings['TAT_' + role + '_DAYS']); return n > 0 ? n : 2; }
function addDays_(d, n) { return new Date(d.getTime() + n * 86400000); }
function fmtDate_(d, withTime) {
  if (!(d instanceof Date)) return String(d || '');
  return Utilities.formatDate(d, Session.getScriptTimeZone(), withTime ? 'dd MMM yyyy, hh:mm a' : 'dd MMM yyyy');
}
function daysSince_(d) { return d instanceof Date ? Math.max(0, Math.floor((Date.now() - d.getTime()) / 86400000)) : ''; }
function isOverdue_(t) { return t['Due By'] instanceof Date && Date.now() > t['Due By'].getTime() && [STAGE.RM, STAGE.HO, STAGE.FR, STAGE.CUST].indexOf(t['Stage']) >= 0; }
function linkFor_(t, role) { return ScriptApp.getService().getUrl() + '?page=approve&t=' + t[TOKEN_COLS[role]]; }

/** Key for the Head Costing tracker link (made once, kept in Settings). */
function trackerKey_(ss) {
  var s = settingsWithDefaults_(ss);
  if (s.TRACKER_KEY) return s.TRACKER_KEY;
  var key = Utilities.getUuid().replace(/-/g, '').slice(0, 20);
  saveSetting_(ss, 'TRACKER_KEY', key);
  return key;
}
function trackerUrl_(ss) { return ScriptApp.getService().getUrl() + '?page=tracker&k=' + trackerKey_(ss); }

function saveSetting_(ss, k, v) {
  var st = ss.getSheetByName('Settings'), data = st.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) if (String(data[i][0]).trim() === k) { st.getRange(i + 1, 2).setValue(v); return; }
  st.appendRow([k, v, '']);
}

/* -------------------------------------------------------------- approvals */

/** Data for the approval page: RM, Head Costing or field rep, decided by whose token it is. */
function approvalView_(token) {
  var ss = responseSheet_();
  var f = trackerByToken_(ss, token);
  if (!f) return { ok: false, error: 'This link is not valid.' };
  var t = f.t, role = f.role, stage = String(t['Stage']), id = String(t['Visit ID']);
  var canEdit = false, wait = '';
  if (role === 'RM') {
    canEdit = [STAGE.RM, STAGE.RM_REJ, STAGE.HO].indexOf(stage) >= 0 && String(t['HO At']) === '';
    if (!canEdit) wait = 'Head Costing has already decided. Your decision is locked.';
  } else if (role === 'HO') {
    canEdit = [STAGE.HO, STAGE.HO_REJ, STAGE.FR].indexOf(stage) >= 0 && String(t['Outcome']) === '';
    if (stage === STAGE.RM) wait = 'Waiting for the Regional Manager. This opens for you after the RM decides.';
    else if (stage === STAGE.RM_REJ) wait = 'The Regional Manager rejected every lane, so this visit stopped there.';
    else if (!canEdit) wait = 'The field rep has already recorded the customer outcome. Your decision is locked.';
  } else {
    canEdit = [STAGE.FR, STAGE.CUST].indexOf(stage) >= 0;
    if ([STAGE.RM, STAGE.HO].indexOf(stage) >= 0) wait = 'Still under approval (' + stage + '). You get a mail when Head Costing approves the rates.';
    else if (stage === STAGE.RM_REJ || stage === STAGE.HO_REJ) wait = 'This visit was ' + stage.toLowerCase() + '.';
    else if (!canEdit) wait = 'Outcome recorded: ' + stage + '.';
  }
  var ans = responseValues_(ss, id);
  return {
    ok: true, token: token, role: role, stage: stage, canEdit: canEdit, wait: wait, id: id,
    due: fmtDate_(t['Due By'], true), overdue: isOverdue_(t),
    visit: { customer: t['Customer'], zone: t['Customer Zone'], city: t['City'], rep: t['Field Rep'], empId: t['Employee ID'],
      submitted: fmtDate_(t['Submitted At'], true), visitDate: fmtDate_(t['Visit Date']), potValue: t['Potential / month'],
      mValue: ans.mValue || '', mVolume: ans.mVolume || '', commodity: ans.commodity || '', expRate: ans.expRate || '' },
    rm: { status: t['RM Status'], remark: t['RM Remark'], at: fmtDate_(t['RM At'], true) },
    ho: { status: t['HO Status'], remark: t['HO Remark'], at: fmtDate_(t['HO At'], true) },
    outcome: { value: t['Outcome'], remark: t['Outcome Remark'], at: fmtDate_(t['Outcome At'], true) },
    lanes: visitLanes_(ss, id).map(function (l) {
      return { tab: l.tab, row: l.row, oz: l.oz, o: l.o, dz: l.dz, d: l.d, dp: l.dp, mt: l.mt, suggested: l.suggested,
        rmDec: l.rmDec, rmRate: l.rmRate, hoDec: l.hoDec, hoRate: l.hoRate, finalRate: l.finalRate };
    })
  };
}

/**
 * RM or Head Costing decision from the approval page.
 * lanes = [{ tab, row, decision: APPROVED | REJECTED, rate }]. A remark is required when any lane is rejected.
 * RM: all lanes rejected = stop (Rejected by RM), otherwise on to Head Costing.
 * Head Costing: decides only the lanes the RM approved. Approved rate left empty = the RM rate.
 */
function approveSave(token, lanes, remark) {
  var OK = ['APPROVED', 'REJECTED'];
  lanes = Array.isArray(lanes) ? lanes : [];
  remark = String(remark || '').trim();
  var ss = responseSheet_();
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var f = trackerByToken_(ss, token);
    if (!f || f.role === 'FR') throw new Error('This approval link is not valid.');
    var view = approvalView_(token);
    if (!view.canEdit) throw new Error(view.wait || 'This visit can no longer be changed.');
    var t = f.t, role = f.role, id = String(t['Visit ID']), now = new Date(), settings = settingsWithDefaults_(ss);
    var byKey = {};
    lanes.forEach(function (x) { byKey[x.tab + '|' + x.row] = x; });
    var mine = visitLanes_(ss, id).filter(function (l) { return role === 'RM' || l.rmDec !== 'REJECTED'; });
    if (!mine.length) throw new Error('No lanes to decide.');
    var decided = mine.map(function (l) {
      var x = byKey[l.tab + '|' + l.row];
      if (!x || OK.indexOf(x.decision) < 0) throw new Error('Approve or reject every lane.');
      var rate = String(x.rate == null ? '' : x.rate).trim();
      if (rate && !(Number(rate) >= 0)) throw new Error('Rates must be numbers.');
      return { l: l, dec: x.decision, rate: num_(rate) };
    });
    var rejected = decided.filter(function (d) { return d.dec === 'REJECTED'; }).length;
    if (rejected && !remark) throw new Error('A remark is required when a lane is rejected.');
    var status = !rejected ? 'APPROVED' : rejected === decided.length ? 'REJECTED' : 'PARTIAL';

    if (role === 'RM') {
      decided.forEach(function (d) {
        setLane_(ss, d.l, { 'RM Decision': d.dec, 'RM Rate': d.dec === 'REJECTED' ? '' : d.rate, 'Lane Status': d.dec === 'REJECTED' ? STAGE.RM_REJ : STAGE.HO });
      });
      var stage = status === 'REJECTED' ? STAGE.RM_REJ : STAGE.HO;
      updateTracker_(ss, t, { 'RM Status': status, 'RM Remark': remark, 'RM At': now, 'Stage': stage, 'Stage Since': now,
        'HO Status': stage === STAGE.RM_REJ ? 'NOT SENT' : 'PENDING',
        'Due By': stage === STAGE.HO ? addDays_(now, tat_(settings, 'HO')) : '' });
      writeResponseStatus_(ss, id, { 'Stage': stage, 'RM Status': status, 'RM Remark': remark, 'RM At': now });
      setLanesStage_(ss, id, stage);
      if (stage === STAGE.RM_REJ) mailRep_(ss, t, 'RM_REJ');
      else if (isInstant_(settings)) mailApprover_(ss, t, 'HO');
    } else {
      var rates = [];
      decided.forEach(function (d) {
        var fin = d.dec === 'APPROVED' ? (d.rate !== '' ? d.rate : num_(d.l.rmRate)) : '';
        setLane_(ss, d.l, { 'HO Decision': d.dec, 'HO Approved Rate': d.dec === 'REJECTED' ? '' : d.rate, 'Final Rate': fin,
          'Lane Status': d.dec === 'REJECTED' ? STAGE.HO_REJ : 'Approved' });
        if (d.dec === 'APPROVED') rates.push(laneName_(d.l) + ': ' + (fin !== '' ? 'Rs ' + fin : 'rate not set'));
      });
      var stage2 = status === 'REJECTED' ? STAGE.HO_REJ : STAGE.FR;
      updateTracker_(ss, t, { 'HO Status': status, 'HO Approved Rates': rates.join('; '), 'HO Remark': remark, 'HO At': now,
        'Stage': stage2, 'Stage Since': now, 'Due By': stage2 === STAGE.FR ? addDays_(now, tat_(settings, 'FR')) : '' });
      writeResponseStatus_(ss, id, { 'Stage': stage2, 'HO Status': status, 'HO Approved Rates': rates.join('; '), 'HO Remark': remark, 'HO At': now });
      setLanesStage_(ss, id, stage2);
      mailRep_(ss, t, stage2 === STAGE.HO_REJ ? 'HO_REJ' : 'RATES');
    }
    refreshAllData_(ss);
    return approvalView_(token);
  } finally {
    lock.releaseLock();
  }
}

/** Field rep outcome after the revisit: FINALIZED | PENDING_CUSTOMER | REFUSED. Rates cannot be changed here. */
function outcomeSave(token, outcome, remark) {
  remark = String(remark || '').trim();
  if (!OUTCOMES[outcome]) throw new Error('Choose an outcome.');
  if (outcome === 'REFUSED' && !remark) throw new Error('Please write why the customer refused.');
  var ss = responseSheet_();
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var f = trackerByToken_(ss, token);
    if (!f || f.role !== 'FR') throw new Error('This link is not valid.');
    var view = approvalView_(token);
    if (!view.canEdit) throw new Error(view.wait || 'This visit can no longer be changed.');
    var t = f.t, now = new Date(), stage = OUTCOMES[outcome], settings = settingsWithDefaults_(ss);
    updateTracker_(ss, t, { 'Outcome': stage, 'Outcome Remark': remark, 'Outcome At': now, 'Stage': stage, 'Stage Since': now,
      'Due By': stage === STAGE.CUST ? addDays_(now, tat_(settings, 'FR')) : '' });
    writeResponseStatus_(ss, String(t['Visit ID']), { 'Stage': stage, 'Outcome': stage, 'Outcome Remark': remark, 'Outcome At': now });
    setLanesStage_(ss, String(t['Visit ID']), stage);
    refreshAllData_(ss);
    return approvalView_(token);
  } finally {
    lock.releaseLock();
  }
}

/* ------------------------------------------------------------------- mail */

var MAIL_FROM_NAME = 'Sugam Customer Onboarding';

function mailShell_(title, sub, body) {
  return '<div style="font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#1b2333;max-width:820px">' +
    '<div style="background:#2a3273;color:#fff;padding:16px 20px;border-radius:10px 10px 0 0;border-bottom:4px solid #e9622b">' +
    '<div style="font-size:11px;letter-spacing:2px;color:#f8ae40;font-weight:bold">SUGAM GROUP &middot; CUSTOMER ONBOARDING JOURNEY</div>' +
    '<div style="font-size:20px;font-weight:bold;margin-top:4px">' + title + '</div>' +
    (sub ? '<div style="opacity:.85">' + sub + '</div>' : '') + '</div><div style="padding:16px 4px">' + body + '</div></div>';
}
var TD_ = 'border:1px solid #dfe4ec;padding:7px 10px;vertical-align:top;font-size:13px;';
function th_(t) { return '<th style="' + TD_ + 'background:#2a3273;color:#fff;text-align:left;font-size:12px">' + t + '</th>'; }
function td_(v, style) { return '<td style="' + TD_ + (style || '') + '">' + v + '</td>'; }
function btn_(href, text) {
  return '<a href="' + href + '" style="display:inline-block;background:#e9622b;color:#fff;text-decoration:none;font-weight:bold;font-size:14px;padding:10px 22px;border-radius:8px">' + text + '</a>';
}
function rs_(v) { return v === '' || v == null ? '-' : 'Rs ' + esc_(v); }

/** Mail_Log tab in the response sheet; made again if someone deleted it. */
function mailLog_(ss) {
  var sh = ss.getSheetByName('Mail_Log');
  if (!sh) { sh = ss.insertSheet('Mail_Log'); sh.appendRow(['Time', 'What / customer', 'Zone', 'To', 'Status']); sh.setFrozenRows(1); }
  return sh;
}

function sendMail_(ss, m, what) {
  try {
    m.name = m.name || MAIL_FROM_NAME;
    MailApp.sendEmail(m);
    mailLog_(ss).appendRow([new Date(), what, '', m.to + (m.cc ? ' | cc: ' + m.cc : ''), 'SENT']);
    return true;
  } catch (err) {
    mailLog_(ss).appendRow([new Date(), what, '', m.to, 'FAILED: ' + err.message]);
    return false;
  }
}

/** Mail to the field rep: HO approved rates (with the outcome link), or a rejection. */
function mailRep_(ss, t, kind) {
  var to = String(t['Rep Email'] || '').trim();
  if (!to) return;
  var id = String(t['Visit ID']), lanes = visitLanes_(ss, id), settings = settingsWithDefaults_(ss);
  var sub = esc_(t['Customer Zone']) + ' &middot; Visit ID ' + esc_(id);
  var rows = lanes.map(function (l) {
    var ok = l.hoDec === 'APPROVED';
    var res = l.rmDec === 'REJECTED' ? 'Rejected by RM' : l.hoDec === 'REJECTED' ? 'Rejected by Head Costing' : ok ? 'Approved' : '-';
    return '<tr>' + td_(esc_(laneName_(l))) + td_(rs_(l.suggested)) + td_(rs_(l.rmRate)) +
      td_(ok ? rs_(l.finalRate) : '-', 'font-weight:bold;color:#127a43') + td_(res, ok ? 'color:#127a43' : 'color:#c62f3b') + '</tr>';
  }).join('');
  var table = '<table style="border-collapse:collapse;width:100%"><tr>' + th_('Lane') + th_('Your price') + th_('RM rate') + th_('HO approved rate') + th_('Result') + '</tr>' + rows + '</table>';
  var subject, body;
  if (kind === 'RATES') {
    subject = 'HO approved rates: ' + t['Customer'] + ' | discuss with the customer';
    body = '<p>Hi ' + esc_(t['Field Rep']) + ',</p><p>Head Costing has approved the rates below for <b>' + esc_(t['Customer']) + '</b>. ' +
      'Please revisit the customer, discuss these rates and record the outcome within <b>' + tat_(settings, 'FR') + ' days</b> ' +
      '(by ' + esc_(fmtDate_(t['Due By'], true)) + '). Rates cannot be changed on the outcome page.</p>' +
      '<p>' + btn_(linkFor_(t, 'FR'), 'Record customer outcome &rarr;') + '</p>' + table +
      (t['HO Remark'] ? '<p><b>Head Costing remark:</b> ' + esc_(t['HO Remark']) + '</p>' : '') +
      (t['RM Remark'] ? '<p><b>RM remark:</b> ' + esc_(t['RM Remark']) + '</p>' : '');
  } else {
    var who = kind === 'RM_REJ' ? 'the Regional Manager' : 'Head Costing';
    subject = 'Visit rejected by ' + (kind === 'RM_REJ' ? 'RM' : 'Head Costing') + ': ' + t['Customer'];
    body = '<p>Hi ' + esc_(t['Field Rep']) + ',</p><p>The visit for <b>' + esc_(t['Customer']) + '</b> was rejected by ' + who + '.</p>' +
      '<p><b>Reason:</b> ' + esc_(kind === 'RM_REJ' ? t['RM Remark'] : t['HO Remark']) + '</p>' + table;
  }
  var m = { to: to, subject: subject, htmlBody: mailShell_(esc_(t['Customer']), sub, body) };
  if (kind === 'RM_REJ') {
    var rm = rmOf_(ss, t);
    m.name = fromName_(rm.name || 'Regional Manager');
    if (rm.email) m.replyTo = rm.email;
  } else {
    m.name = fromName_('Head Costing');
    if (settings.COSTING_HEAD_EMAIL) m.replyTo = settings.COSTING_HEAD_EMAIL;
  }
  sendMail_(ss, m, 'Field rep mail (' + kind + ', ' + id + ')');
}

/** Sender name shown in the inbox, e.g. "Ravi Kumar via Sugam Onboarding". The address is always the deployer's. */
function fromName_(who) { return String(who || '').trim() ? String(who).trim() + ' via Sugam Onboarding' : MAIL_FROM_NAME; }

function isInstant_(settings) { return String(settings.INSTANT_MAIL).toUpperCase() === 'YES'; }

/** RM of the visit's customer zone (current Zone_Emails, else the email saved on the visit). */
function rmOf_(ss, t) {
  var z = findZone_(ss, String(t['Customer Zone'] || ''));
  return { name: z.name, email: z.email || String(t['RM Email'] || ''), cc: z.cc };
}

/**
 * Instant mail (INSTANT_MAIL = YES) to the next approver of one visit.
 * RM: sent as the field rep (name + reply-to). Head Costing: sent as the RM, or as the field rep when the zone has no RM.
 */
function mailApprover_(ss, t, role) {
  if (!t) return;
  var settings = settingsWithDefaults_(ss), id = String(t['Visit ID']), rm = rmOf_(ss, t);
  var to = role === 'RM' ? rm.email : String(settings.COSTING_HEAD_EMAIL || '').trim();
  if (!to) return;
  var fromRm = role === 'HO' && t['RM Status'] && t['RM Status'] !== 'NO RM EMAIL';
  var rows = visitLanes_(ss, id).filter(function (l) { return role === 'RM' || l.rmDec !== 'REJECTED'; }).map(function (l) {
    return '<tr>' + td_(esc_(laneName_(l))) + td_(rs_(l.suggested)) + (role === 'HO' ? td_(rs_(l.rmRate)) : '') + '</tr>';
  }).join('');
  var body = '<p>Dear ' + esc_(role === 'RM' ? (rm.name || 'Regional Manager') : 'Head Costing') + ',</p><p>' +
    (fromRm ? esc_(rm.name || 'The Regional Manager') + ' has approved' : esc_(t['Field Rep']) + ' (Employee ID ' + esc_(t['Employee ID'] || '-') + ') has submitted') +
    ' a customer visit for <b>' + esc_(t['Customer']) + '</b>. Please approve or reject each lane within <b>' + tat_(settings, role) + ' days</b>.</p>' +
    '<table style="border-collapse:collapse;margin:6px 0 14px"><tr>' + th_('Visit ID') + th_('Field rep') + th_('Employee ID') + th_('Customer') + th_('Zone') + th_('Potential / month') + '</tr><tr>' +
    td_(esc_(id)) + td_(esc_(t['Field Rep'])) + td_(esc_(t['Employee ID'])) + td_('<b>' + esc_(t['Customer']) + '</b>') + td_(esc_(t['Customer Zone'])) + td_(rs_(t['Potential / month'])) + '</tr></table>' +
    '<table style="border-collapse:collapse;width:100%"><tr>' + th_('Lane') + th_('Field rep price') + (role === 'HO' ? th_('RM rate') : '') + '</tr>' + rows + '</table>' +
    (fromRm && t['RM Remark'] ? '<p><b>RM remark:</b> ' + esc_(t['RM Remark']) + '</p>' : '') +
    '<p style="margin-top:16px">' + btn_(linkFor_(t, role), 'Open &amp; approve &rarr;') + '</p>';
  var m = { to: to, subject: (role === 'RM' ? 'Approval needed: ' : 'Head Costing approval needed: ') + t['Customer'] + ' (' + id + ')',
    htmlBody: mailShell_(esc_(t['Customer']), esc_(t['Customer Zone']) + ' &middot; Visit ID ' + esc_(id), body),
    name: fromName_(fromRm ? (rm.name || 'Regional Manager') : t['Field Rep']) };
  var reply = fromRm ? rm.email : String(t['Rep Email'] || '').trim();
  if (reply) m.replyTo = reply;
  if (role === 'RM' && rm.cc) m.cc = rm.cc;
  if (role === 'HO' && settings.ALWAYS_CC) m.cc = settings.ALWAYS_CC;
  sendMail_(ss, m, 'Instant ' + role + ' mail (' + id + ')');
}

/* ----------------------------------------------------------------- digest */

/**
 * Digest mails: one per Regional Manager (their zones, pending at RM), one to Head Costing
 * (pending at Head Costing + stage counts + tracker link), one per field rep (rates to discuss).
 * A person gets a mail only when something is waiting for them.
 */
function sendDigests_(ss) {
  var rows = trackerRows_(ss), settings = settingsWithDefaults_(ss), out = { rm: 0, ho: 0, fr: 0 };
  var zones = {};
  ss.getSheetByName('Zone_Emails').getDataRange().getValues().slice(1).forEach(function (r) {
    var z = String(r[0]).trim().toUpperCase(); if (z) zones[z] = { name: String(r[1]).trim(), email: String(r[2]).trim(), cc: String(r[3]).trim() };
  });
  var digestTable = function (list, role, extraHead, extraCell) {
    return '<table style="border-collapse:collapse;width:100%"><tr>' + th_('Visit ID') + th_('Field rep') + th_('Employee ID') + th_('Customer') +
      th_('Zone') + th_('Potential / month') + th_('Submitted') + th_('Days pending') + (extraHead || '') + th_('Action') + '</tr>' +
      list.map(function (t) {
        var late = isOverdue_(t);
        return '<tr>' + td_(esc_(t['Visit ID'])) + td_(esc_(t['Field Rep'])) + td_(esc_(t['Employee ID'])) + td_('<b>' + esc_(t['Customer']) + '</b>') +
          td_(esc_(t['Customer Zone'])) + td_(rs_(t['Potential / month'])) + td_(esc_(fmtDate_(t['Submitted At']))) +
          td_(daysSince_(t['Stage Since']) + (late ? ' (overdue)' : ''), late ? 'color:#c62f3b;font-weight:bold' : '') + (extraCell ? extraCell(t) : '') +
          td_('<a href="' + linkFor_(t, role) + '" style="color:#e9622b;font-weight:bold">Open &amp; ' + (role === 'FR' ? 'update' : 'approve') + '</a>') + '</tr>';
      }).join('') + '</table>';
  };

  // Regional Managers: their own zones only
  var byRm = {};
  rows.filter(function (t) { return t['Stage'] === STAGE.RM; }).forEach(function (t) {
    var z = zones[String(t['Customer Zone']).trim().toUpperCase()] || {}, email = z.email || String(t['RM Email'] || '');
    if (!email) return;
    (byRm[email] = byRm[email] || { name: z.name, cc: z.cc, list: [] }).list.push(t);
  });
  Object.keys(byRm).forEach(function (email) {
    var g = byRm[email];
    var body = '<p>Dear ' + esc_(g.name || 'Regional Manager') + ',</p><p><b>' + g.list.length + '</b> customer visit' + (g.list.length > 1 ? 's are' : ' is') +
      ' waiting for your approval. Open each one, approve or reject every lane and enter the RM rate. You have ' + tat_(settings, 'RM') + ' days per visit.</p>' +
      digestTable(g.list, 'RM');
    var m = { to: email, subject: 'Pending your approval: ' + g.list.length + ' customer visit' + (g.list.length > 1 ? 's' : ''),
      htmlBody: mailShell_('Approvals pending at RM', 'Regional Manager digest', body) };
    if (g.cc) m.cc = g.cc;
    if (sendMail_(ss, m, 'RM digest (' + g.list.length + ')')) out.rm++;
  });

  // Head Costing: everything pending at HO + counts of every stage
  var ho = String(settings.COSTING_HEAD_EMAIL || '').trim();
  var pendHo = rows.filter(function (t) { return t['Stage'] === STAGE.HO; });
  if (ho && pendHo.length) {
    var counts = {};
    rows.forEach(function (t) { counts[t['Stage']] = (counts[t['Stage']] || 0) + 1; });
    var countRow = '<table style="border-collapse:collapse;margin:6px 0 14px"><tr>' + Object.keys(STAGE).map(function (k) { return th_(STAGE[k]); }).join('') + '</tr><tr>' +
      Object.keys(STAGE).map(function (k) { return td_('<b>' + (counts[STAGE[k]] || 0) + '</b>', 'text-align:center'); }).join('') + '</tr></table>';
    var body2 = '<p>Dear Head Costing,</p><p><b>' + pendHo.length + '</b> visit' + (pendHo.length > 1 ? 's are' : ' is') +
      ' approved by the Regional Manager and waiting for your approved rates.</p>' + countRow +
      '<p>' + btn_(trackerUrl_(ss), 'Open the visit tracker &rarr;') + '</p>' +
      digestTable(pendHo, 'HO', th_('RM decision'), function (t) { return td_(esc_(t['RM Status'])); });
    var m2 = { to: ho, subject: 'Pending Head Costing approval: ' + pendHo.length + ' customer visit' + (pendHo.length > 1 ? 's' : ''),
      htmlBody: mailShell_('Approvals pending at Head Costing', 'Head Costing digest', body2) };
    if (settings.ALWAYS_CC) m2.cc = settings.ALWAYS_CC;
    if (sendMail_(ss, m2, 'Head Costing digest (' + pendHo.length + ')')) out.ho++;
  }

  // Field reps: HO rates received, customer outcome pending
  var byRep = {};
  rows.filter(function (t) { return [STAGE.FR, STAGE.CUST].indexOf(t['Stage']) >= 0 && t['Rep Email']; }).forEach(function (t) {
    (byRep[t['Rep Email']] = byRep[t['Rep Email']] || []).push(t);
  });
  Object.keys(byRep).forEach(function (email) {
    var list = byRep[email];
    var body3 = '<p>Hi ' + esc_(list[0]['Field Rep']) + ',</p><p>Head Costing has replied on these visits. Please discuss the approved rates with the customer and record the outcome (' +
      tat_(settings, 'FR') + ' days per visit).</p>' + digestTable(list, 'FR', th_('Stage'), function (t) { return td_(esc_(t['Stage'])); });
    var m3 = { to: email, subject: 'Action pending: ' + list.length + ' customer visit' + (list.length > 1 ? 's' : '') + ' with HO approved rates',
      htmlBody: mailShell_('Customer outcome pending', 'Field representative digest', body3) };
    if (settings.COSTING_HEAD_EMAIL) m3.replyTo = settings.COSTING_HEAD_EMAIL;
    if (sendMail_(ss, m3, 'Field rep digest (' + list.length + ')')) out.fr++;
  });
  return out;
}

/** Runs from the time triggers set in Admin (DIGEST_TIMES). Not callable from a page. */
function runDigest(e) {
  if (!e || !e.triggerUid) return;
  var ss = responseSheet_();
  if (String(settingsWithDefaults_(ss).DIGEST_ON).toUpperCase() !== 'YES') return;
  sendDigests_(ss);
}

/** Hours from DIGEST_TIMES, e.g. "14:00, 17:00" > [14, 17]. */
function digestHours_(txt) {
  var out = [], d = String(txt || '').match(/\b(\d{2}):\d{2}:\d{2} GMT/);
  if (d) return [Number(d[1])];
  String(txt || '').split(/[,;]/).forEach(function (p) {
    var m = p.trim().match(/^(\d{1,2})(?::\d{2})?\s*(am|pm)?$/i); if (!m) return;
    var h = Number(m[1]); if (m[2]) h = (h % 12) + (/pm/i.test(m[2]) ? 12 : 0);
    if (h >= 0 && h < 24 && out.indexOf(h) < 0) out.push(h);
  });
  return out.sort(function (a, b) { return a - b; });
}

/** Recreates the digest triggers from Settings and the hourly master refresh. Returns the digest hours in use. */
function installDigestTriggers_(ss) {
  ScriptApp.getProjectTriggers().forEach(function (tr) {
    if (['runDigest', 'runMasterRefresh'].indexOf(tr.getHandlerFunction()) >= 0) ScriptApp.deleteTrigger(tr);
  });
  ScriptApp.newTrigger('runMasterRefresh').timeBased().everyHours(1).create();
  var s = settingsWithDefaults_(ss);
  if (String(s.DIGEST_ON).toUpperCase() !== 'YES') return [];
  var hours = digestHours_(s.DIGEST_TIMES);
  hours.forEach(function (h) {
    ScriptApp.newTrigger('runDigest').timeBased().atHour(h).nearMinute(0).everyDays(1).inTimezone(Session.getScriptTimeZone()).create();
  });
  return hours;
}

/* ---------------------------------------------------------- tracker page */

/** Every visit with its stage, for the Head Costing tracker page. */
function trackerView_(key) {
  var ss = responseSheet_();
  if (!key || String(key) !== trackerKey_(ss)) return { ok: false, error: 'This tracker link is not valid.' };
  return {
    ok: true, stages: STAGE,
    rows: trackerRows_(ss).map(function (t) {
      return { id: t['Visit ID'], submitted: fmtDate_(t['Submitted At']), rep: t['Field Rep'], empId: t['Employee ID'], customer: t['Customer'],
        zone: t['Customer Zone'], city: t['City'], potential: t['Potential / month'], lanes: t['Lanes'], stage: t['Stage'],
        days: daysSince_(t['Stage Since']), due: fmtDate_(t['Due By'], true), overdue: isOverdue_(t),
        rm: t['RM Status'], rmRemark: t['RM Remark'], ho: t['HO Status'], hoRates: t['HO Approved Rates'], hoRemark: t['HO Remark'],
        outcome: t['Outcome'], outcomeRemark: t['Outcome Remark'], link: linkFor_(t, 'HO') };
    })
  };
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
  if (!ss.getSheetByName(ALL_TAB)) refreshAllData_(ss);
  var triggers = [];
  try {
    triggers = ScriptApp.getProjectTriggers();
    if (!triggers.some(function (tr) { return tr.getHandlerFunction() === 'runMasterRefresh'; })) { installDigestTriggers_(ss); triggers = ScriptApp.getProjectTriggers(); }
  } catch (err) { triggers = []; }   // first admin visit after this update schedules the digest + hourly refresh
  var s = settingsWithDefaults_(ss);
  var c = masterCounts_(masters);
  c.source = masters.source; c.error = masters.error || ''; c.readAt = masters.readAt || '';
  return {
    config: readConfig_(ss),
    zones: ze.getDataRange().getValues().slice(1).filter(function (r) { return String(r[0]).trim(); })
      .map(function (r) { return { zone: String(r[0]), name: String(r[1]), email: String(r[2]), cc: String(r[3]) }; }),
    settings: ADMIN_SETTINGS.reduce(function (o, k) { o[k] = s[k] == null ? '' : s[k]; return o; }, {}),
    masters: c,
    sheetUrl: ss.getUrl(),
    trackerUrl: trackerUrl_(ss),
    digestHours: triggers.filter(function (tr) { return tr.getHandlerFunction() === 'runDigest'; }).length ? digestHours_(s.DIGEST_TIMES) : [],
    timeZone: Session.getScriptTimeZone(),
    oldTabs: oldTabs_(ss)
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
    refreshAllData_(ss);
  } finally {
    lock.releaseLock();
  }
  return readConfig_(ss);
}

var ADMIN_SETTINGS = ['ADMIN_PIN', 'COSTING_HEAD_EMAIL', 'ALWAYS_CC', 'GR_MASTER_SHEET', 'GR_MASTER_TAB',
  'DIGEST_ON', 'INSTANT_MAIL', 'DIGEST_TIMES', 'TAT_RM_DAYS', 'TAT_HO_DAYS', 'TAT_FR_DAYS'];

/** Saves zone emails, approval and digest settings, GR master link; re-creates the digest triggers. */
function adminSaveMail(pin, zones, settings, fresh, removed) {
  var ss = responseSheet_();
  checkPin_(ss, pin);
  zones = Array.isArray(zones) ? zones : [];
  settings = settings || {};
  // Check everything first, so nothing is half saved
  var EMAILS = /^\s*[^@\s,;]+@[^@\s,;]+\.[^@\s,;]+\s*$/;
  var listOk = function (v) { return !String(v || '').trim() || String(v).split(/[,;]/).every(function (e) { return EMAILS.test(e); }); };
  zones.forEach(function (z) {
    if (!listOk(z.email)) throw new Error('RM email for ' + z.zone + ' looks wrong: ' + z.email);
    if (!listOk(z.cc)) throw new Error('Extra CC for ' + z.zone + ' looks wrong: ' + z.cc);
  });
  if (!listOk(settings.COSTING_HEAD_EMAIL)) throw new Error('Head Costing email looks wrong: ' + settings.COSTING_HEAD_EMAIL);
  if (!listOk(settings.ALWAYS_CC)) throw new Error('CC email looks wrong: ' + settings.ALWAYS_CC);
  if ('ADMIN_PIN' in settings && String(settings.ADMIN_PIN).trim().length < 4) throw new Error('The admin PIN needs at least 4 characters.');
  if (String(settings.DIGEST_ON).toUpperCase() === 'YES' && !digestHours_(settings.DIGEST_TIMES).length)
    throw new Error('Digest times look wrong. Example: 14:00, 17:00');

  var ze = ss.getSheetByName('Zone_Emails');
  // Zones removed on the page
  (Array.isArray(removed) ? removed : []).forEach(function (zn) {
    var d = ze.getDataRange().getValues();
    for (var i = d.length - 1; i >= 1; i--) if (String(d[i][0]).trim().toUpperCase() === String(zn).trim().toUpperCase()) ze.deleteRow(i + 1);
  });
  // Only the zones changed on the page are written, by zone name, so emails typed straight
  // into the Zone_Emails tab are never wiped by an Admin page that was opened earlier.
  var data = ze.getDataRange().getValues();
  zones.filter(function (z) { return String(z.zone).trim(); }).forEach(function (z) {
    var row = [String(z.zone).trim(), String(z.name || '').trim(), String(z.email || '').trim(), String(z.cc || '').trim()];
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][0]).trim().toUpperCase() === row[0].toUpperCase()) { ze.getRange(i + 1, 1, 1, 4).setNumberFormat('@').setValues([row]); return; }
    }
    ze.appendRow(row);
  });

  var st = ss.getSheetByName('Settings');
  var data = st.getDataRange().getValues();
  Object.keys(settings).forEach(function (k) {
    if (ADMIN_SETTINGS.indexOf(k) < 0) return;
    var v = String(settings[k] == null ? '' : settings[k]).trim();
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][0]).trim() === k) { st.getRange(i + 1, 2).setNumberFormat('@').setValue(v); return; }
    }
    st.appendRow([k, v, '']);
  });
  SpreadsheetApp.flush();
  var warning = '';
  try { installDigestTriggers_(ss); } catch (err) { warning = 'Saved, but the digest schedule could not be set: ' + err.message; }
  var out = adminLoad(String(settingsWithDefaults_(ss).ADMIN_PIN).trim(), !!fresh);
  out.warning = warning;
  return out;
}

/** Admin "Mail check": last Mail_Log rows. */
function adminMailCheck(pin) {
  var ss = responseSheet_();
  checkPin_(ss, pin);
  var v = mailLog_(ss).getDataRange().getValues().slice(1).slice(-25).reverse();
  return v.map(function (r) { return r.map(function (x) { return x instanceof Date ? fmtDate_(x, true) : String(x); }); });
}

/** Admin "Test": sends a short test mail to one zone's RM, so routing can be checked without a form. */
function adminTestZone(pin, zone) {
  var ss = responseSheet_();
  checkPin_(ss, pin);
  var rm = findZone_(ss, String(zone || ''));
  if (!rm.email) throw new Error('No RM email for ' + zone + ' in Zone_Emails.');
  var ok = sendMail_(ss, { to: rm.email, cc: rm.cc || undefined, subject: 'Test: customer visit approvals for ' + zone,
    htmlBody: mailShell_('Test mail', esc_(zone), '<p>Dear ' + esc_(rm.name || 'Regional Manager') + ',</p><p>This is a test. Customer visits for <b>' + esc_(zone) +
      '</b> will come to this address for RM approval.</p>') }, 'Test RM mail (' + zone + ')');
  if (!ok) throw new Error('Mail to ' + rm.email + ' failed. See Mail_Log.');
  return 'Test mail sent to ' + rm.email + (rm.cc ? ' (cc ' + rm.cc + ')' : '');
}

/* ---------------------------------------------------------- All_Data tab */

/**
 * All_Data: the one tab to read. One row per customer lane with every form answer,
 * the lane prices, RM / Head Costing decisions and rates, stage and customer outcome.
 * Rebuilt after every submit, approval, outcome and delete. The working tabs it is built
 * from (Web_Responses, Customer_Lanes, Visit_Tracker, ...) are kept hidden.
 */
var ALL_TAB = 'All_Data';
var ALL_LANE_COLS = ['Lane', 'Origin Zone', 'Origin', 'Destination Zone', 'Destination', 'Delivery Point', 'Lane (From > To)',
  'Suggested Price (Field Rep)', 'Origin MT / month', 'Frequency', 'Note', 'RM Decision', 'RM Rate', 'HO Decision', 'HO Approved Rate', 'Final Rate', 'Lane Status'];
var HIDDEN_TABS = ['Web_Responses', CL_TAB, TRACKER_TAB, 'Mail_Log', 'Form_Config', 'Settings', 'Zone_Emails', 'Master_Cache'];

function rebuildAllData_(ss) {
  var wr = ss.getSheetByName('Web_Responses');
  var sh = ss.getSheetByName(ALL_TAB) || ss.insertSheet(ALL_TAB, 0);
  var wv = wr && wr.getLastRow() > 0 ? wr.getRange(1, 1, wr.getLastRow(), Math.max(wr.getLastColumn(), 2)).getValues() : [['Submitted At', 'Visit ID']];
  var notes = wr ? wr.getRange(1, 1, 1, wv[0].length).getNotes()[0] : [];
  var flowsId = (readConfig_(ss).filter(function (f) { return f.type === 'flows'; })[0] || {}).id;
  var qCols = [], sysCols = [], stageCol = -1;
  wv[0].forEach(function (h, j) {
    if (j < 2) return;
    var n = String(notes[j] || '');
    if (n === 'fid:' + flowsId || /\(removed\)$/.test(String(h))) return;
    if (n === 'sys:Stage') { stageCol = j; return; }
    (/^sys:/.test(n) ? sysCols : qCols).push(j);
  });
  // lanes by Visit ID
  var lanes = {}, cl = ss.getSheetByName(CL_TAB);
  if (cl && cl.getLastRow() > 1) {
    var lv = cl.getDataRange().getValues(), lh = lv[0], vid = lh.indexOf('Visit ID');
    lv.slice(1).forEach(function (r) { var id = String(r[vid]); (lanes[id] = lanes[id] || []).push(r); });
    var lix = ALL_LANE_COLS.map(function (c) { return lh.indexOf(c); });
  }
  var due = {};
  trackerRows_(ss).forEach(function (t) { due[String(t['Visit ID'])] = t['Due By']; });

  var head = ['Submitted At', 'Visit ID', 'Stage', 'Due By'].concat(qCols.map(function (j) { return wv[0][j]; }), ALL_LANE_COLS, sysCols.map(function (j) { return wv[0][j]; }));
  var rows = [];
  wv.slice(1).forEach(function (r) {
    var id = String(r[1] || ''); if (!id) return;
    var base = [r[0], id, stageCol >= 0 ? r[stageCol] : '', due[id] || ''].concat(qCols.map(function (j) { return r[j]; }));
    var tail = sysCols.map(function (j) { return r[j]; });
    var ls = lanes[id] || [null];
    ls.forEach(function (l) { rows.push(base.concat(ALL_LANE_COLS.map(function (c, k) { return l && lix[k] >= 0 ? l[lix[k]] : ''; }), tail)); });
  });
  sh.clear();
  if (sh.getMaxColumns() < head.length) sh.insertColumnsAfter(sh.getMaxColumns(), head.length - sh.getMaxColumns());
  sh.getRange(1, 1, 1, head.length).setValues([head]).setFontWeight('bold').setBackground('#2a3273').setFontColor('#ffffff').setWrap(true);
  var laneStart = 5 + qCols.length;
  sh.getRange(1, laneStart, 1, ALL_LANE_COLS.length).setBackground('#e9622b');
  if (sysCols.length) sh.getRange(1, laneStart + ALL_LANE_COLS.length, 1, sysCols.length).setBackground('#c62f3b');
  if (rows.length) sh.getRange(2, 1, rows.length, head.length).setValues(rows);
  sh.setFrozenRows(1); sh.setFrozenColumns(2);
  if (sh.getFilter()) sh.getFilter().remove();
  sh.getRange(1, 1, Math.max(rows.length + 1, 2), head.length).createFilter();
  // one visible tab
  if (sh.isSheetHidden()) sh.showSheet();
  HIDDEN_TABS.forEach(function (n) { var t = ss.getSheetByName(n); if (t && !t.isSheetHidden()) t.hideSheet(); });
}

/** Never lets the All_Data refresh break a submit or an approval. */
function refreshAllData_(ss) {
  try { rebuildAllData_(ss); } catch (err) { try { mailLog_(ss).appendRow([new Date(), 'All_Data refresh', '', '', 'FAILED: ' + err.message]); } catch (e) {} }
}

/* ------------------------------------------------------------ entries */

/** Admin "Entries": every visit in Web_Responses with its stage from Visit_Tracker. */
function adminVisits(pin) {
  var ss = responseSheet_();
  checkPin_(ss, pin);
  var track = {};
  trackerRows_(ss).forEach(function (t) { track[String(t['Visit ID'])] = t; });
  var cols = syncResponseColumns_(ss, readConfig_(ss)), sh = cols.sheet, out = [], seen = {};
  var v = sh.getLastRow() > 1 ? sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).getValues() : [];
  var get = function (r, fid) { return cols.colOf[fid] ? String(r[cols.colOf[fid] - 1]) : ''; };
  v.forEach(function (r) {
    var id = String(r[1] || '').trim(); if (!id || seen[id]) return; seen[id] = 1;
    var t = track[id] || {};
    out.push({ id: id, at: r[0] instanceof Date ? fmtDate_(r[0], true) : String(r[0]), rep: get(r, 'repName'), empId: get(r, 'repId'),
      customer: get(r, 'customer'), zone: get(r, 'zone'), stage: t['Stage'] || '(old entry)' });
  });
  Object.keys(track).forEach(function (id) {
    if (seen[id]) return; var t = track[id];
    out.push({ id: id, at: fmtDate_(t['Submitted At'], true), rep: t['Field Rep'], empId: t['Employee ID'], customer: t['Customer'], zone: t['Customer Zone'], stage: t['Stage'] });
  });
  return out.reverse();
}

/** Deletes the rows of the given Visit IDs (or every entry when ids === 'ALL') from all visit tabs. */
function adminDeleteVisits(pin, ids) {
  var ss = responseSheet_();
  checkPin_(ss, pin);
  var all = ids === 'ALL', want = {};
  if (!all) { (ids || []).forEach(function (i) { want[String(i)] = 1; }); if (!Object.keys(want).length) throw new Error('Nothing selected.'); }
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  var n = 0;
  try {
    ['Web_Responses', TRACKER_TAB].concat(LANE_TABS).forEach(function (name) {
      var sh = ss.getSheetByName(name); if (!sh || sh.getLastRow() < 2) return;
      var head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
      var c = head.indexOf('Visit ID'); if (c < 0 && name === 'Web_Responses') c = 1; if (c < 0) return;
      if (all) { n += sh.getLastRow() - 1; sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).clearContent(); return; }
      var v = sh.getRange(2, c + 1, sh.getLastRow() - 1, 1).getValues();
      for (var i = v.length - 1; i >= 0; i--) {
        if (!want[String(v[i][0]).trim()]) continue;
        n++;
        if (sh.getLastRow() === 2 && sh.getMaxRows() <= 2) sh.getRange(2, 1, 1, sh.getLastColumn()).clearContent();
        else sh.deleteRow(i + 2);
      }
    });
    refreshAllData_(ss);
    mailLog_(ss).appendRow([new Date(), 'ADMIN', '', '', all ? 'Deleted ALL entries (' + n + ' rows)' : 'Deleted ' + Object.keys(want).join(', ') + ' (' + n + ' rows)']);
  } finally {
    lock.releaseLock();
  }
  return adminVisits(pin);
}

/** Sends the mail for the visit's current stage again (RM, Head Costing or field rep). */
function adminResend(pin, id) {
  var ss = responseSheet_();
  checkPin_(ss, pin);
  var t = trackerRows_(ss).filter(function (x) { return String(x['Visit ID']) === String(id); })[0];
  if (!t) throw new Error('This entry has no tracker row (old entry).');
  var st = t['Stage'];
  if (st === STAGE.RM) mailApprover_(ss, t, 'RM');
  else if (st === STAGE.HO) mailApprover_(ss, t, 'HO');
  else if (st === STAGE.FR || st === STAGE.CUST) mailRep_(ss, t, 'RATES');
  else throw new Error('Nothing to resend: the visit is ' + st + '.');
  return 'Mail sent again for ' + id + ' (' + st + '). See the mail log.';
}

/** Empties Mail_Log (keeps the header). */
function adminClearMailLog(pin) {
  var ss = responseSheet_();
  checkPin_(ss, pin);
  var sh = mailLog_(ss);
  if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).clearContent();
  return adminMailCheck(pin);
}

/** Customer zones for the form = the zones listed in Zone_Emails (managed in Admin). */
function customerZones_(ss) {
  return ss.getSheetByName('Zone_Emails').getDataRange().getValues().slice(1)
    .map(function (r) { return String(r[0]).trim(); }).filter(String).sort();
}

/** Tabs from earlier versions (old Google Form and old approval flow). The web form does not write to them. */
var OLD_TABS = ['Visit_Lanes', 'Visit_Lanes_v2', 'Visit_Lanes_v3', 'Visit_Flows', 'Approvals', 'Visit_Summary', 'Masters'];
function oldTabs_(ss) { return OLD_TABS.filter(function (n) { return ss.getSheetByName(n); }); }

/** "Remove old tabs" in Admin. */
function adminRemoveOldTabs(pin) {
  var ss = responseSheet_();
  checkPin_(ss, pin);
  var gone = oldTabs_(ss);
  gone.forEach(function (n) { ss.deleteSheet(ss.getSheetByName(n)); });
  var out = adminLoad(pin, false);
  out.removed = gone;
  return out;
}

/** "Send now" in Admin: sends the digest mails right away. */
function adminSendDigest(pin) {
  var ss = responseSheet_();
  checkPin_(ss, pin);
  var r = sendDigests_(ss);
  return 'Sent: ' + r.rm + ' RM digest' + (r.rm === 1 ? '' : 's') + ', ' + r.ho + ' Head Costing digest, ' + r.fr + ' field rep digest' + (r.fr === 1 ? '' : 's') +
    (r.rm + r.ho + r.fr ? '' : ' (nothing is pending)');
}

/** Re-reads the GR master now (otherwise the hourly trigger does it). */
function adminRefreshMasters(pin) {
  return adminLoad(pin, true);
}
