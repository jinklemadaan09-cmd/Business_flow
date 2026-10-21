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

---

# Custom HTML form + Admin panel + Approval (recommended)

Apps Script project (Business_Flow) me ye files honi chahiye. Naam exactly aise (capital letter ke saath):

| File | Type | Content |
|---|---|---|
| `Code` | Script | Sugam_Customer_Visit_Form.gs (setup wala, ek baar chal chuka) |
| `WebApp` (ya webapp.gs) | Script | WebApp.gs |
| `Index` | HTML | Index.html (field rep form) |
| `Admin` | HTML | Admin.html (admin panel) |
| `Approve` | HTML | Approve.html (Costing Head / RM approval page) |

Code badalne ke baad hamesha: **Deploy > Manage deployments > pencil > Version: New version > Deploy** (link wahi rehta hai).

## Kya hota hai
1. Field rep form bharta hai (zones / origin / destination / delivery point GR PNL data master se, unique).
2. **Costing Head** aur zone ke **Regional Manager** ko alag-alag mail jata hai: upar "Approve / Reject & enter rate"
   button, neeche lanes aur poori visit details.
3. Button se approval page khulta hai: Approve / Reject, approved rate (optional), remark (optional).
4. Sheet me save hota hai:
   - `Approvals` - har approver ki ek row (status, rate, remark, time)
   - `Visit_Summary` - columns S se AB: Visit ID, Costing Head status/rate/remark/time, RM status/rate/remark/time, Overall Status
5. Dono ka decision aane pe field rep ko result ka mail (Approved / Rejected + rate).

## Zones & places (GR PNL data master)
Settings me `GR_MASTER_SHEET` (default: GR PNL mirror sheet) aur `GR_MASTER_TAB` (default `DASHBOARD_MASTER`).
Columns jo padhe jaate hain: Origin Zone, Origin, Dest Zone, Destname, Delivery Point (naam me space/underscore/case
se farak nahi padta). "UNSPECIFIED" values chhod di jaati hain. Har 10 minute me refresh, ya Admin > Master data >
Reload master now. Agar padh nahi paya to Admin me error dikhega aur purani lane file copy use hogi.

## Sheet tabs
- `Form_Config` - saare sawaal (admin panel isi ko badalta hai)
- `Web_Responses` - ek visit = ek row, har sawaal ka column
- `Visit_Lanes` - har origin > destination (> delivery point) ki alag row
- `Visit_Summary`, `Approvals`, `Mail_Log`, `Zone_Emails`, `Settings`
