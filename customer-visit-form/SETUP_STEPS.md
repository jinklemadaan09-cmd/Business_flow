# Sugam Customer Visit Form - Setup (10 minute ka kaam)

## 1. Script chalao (sirf ek baar)
1. https://script.google.com kholo (wahi Google account jisse mail jaani hai) > **New project**.
2. Jo code hai usse hata ke `Sugam_Customer_Visit_Form.gs` ka pura content paste karo > **Save** (Ctrl+S).
3. Upar function dropdown me **setup** select karo > **Run**.
4. Permission maangega: *Review permissions* > apna account > *Advanced* > *Go to project (unsafe)* > **Allow**.
   (Ye aapka khud ka script hai, isliye Google ye warning dikhata hai.)
5. Run khatam hone pe niche **Execution log** me 3 link aayenge:
   - **FORM LINK** - ye field representatives ko bhejo (WhatsApp / mail)
   - **FORM EDIT LINK** - form edit karne ke liye
   - **RESPONSE SHEET** - saara data yahan aayega

## 2. Emails bharo (Response sheet me)
**Tab `Zone_Emails`** - 17 zones pehle se likhe hain, bas ye bharo:

| Zone | Regional Manager Name | RM Email | Extra CC (comma separated) |
|---|---|---|---|
| DELHI-NCR | (RM ka naam) | rm.delhi@company.com | (optional) |
| GUJARAT | ... | ... | |

**Tab `Settings`**:

| Key | Value |
|---|---|
| COSTING_HEAD_EMAIL | costing head ki email (ek se zyada ho to comma laga ke) |
| ALWAYS_CC | optional, jaise sales head |
| CC_FIELD_REP | YES (field rep ko bhi copy jayegi) / NO |

Zone ka naam form ke zone se exact match hona chahiye (jo pehle se likha hai wahi rehne do).

## 3. Kya hoga har submission pe
- `Form Responses 1` - har sawaal ka pura jawab
- `Visit_Summary` - ek line me clean summary (customer, zone, potential, origins, destinations, rate, mail status)
- Costing Head (To) + us zone ka RM (To) + field rep (CC) ko HTML mail, subject:
  `New Customer Visit: <Customer> | <Zone> | Potential Rs <x>/month`
- `Mail_Log` - kisko gaya, sent / failed

## 4. Form me kya hai (journey ke Step 01-05)
1. **Customer Visit** - rep, date, customer, zone, contact, decision makers, current transporter, pain points
2. **Monthly Business Potential** - monthly spend, MT, shipments, frequency, seasonality, potential
3. **Material Understanding** - commodity, category, load type, weight, dimensions, packing, risks
4. **Origin & Destination Mapping** - origin zones (multiple), har zone ke Sugam branches (multiple, lane master ke 208 branches), destination regions (multiple), key destination cities, lane-wise detail, branch coverage
5. **Indicative Rate** - rate basis, current / expected / indicative rate, other charges, credit period, follow-up date

## 5. Branch / zone list badalni ho
Response sheet ke tab `Masters` me branch / destination add-remove karo, phir script me function
**refreshFormOptions** select karke Run karo. Naya zone add kiya to `Zone_Emails` me bhi line daal do.

## Dhyan rakhne wali baatein
- Free Gmail se roz ~100 mail limit hai, Google Workspace se ~1500.
- `setup` dobara mat chalao (naya form ban jayega); script khud rok degi.
- Mail nahi gaya to `Mail_Log` ka Status dekho, waha reason likha hoga.
