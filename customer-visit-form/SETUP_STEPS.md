# Sugam Customer Onboarding - Setup and How It Works

## 1. Files in the Apps Script project (Business_Flow)
File names must match exactly, including capital letters.

| File | Type | Content |
|---|---|---|
| `Code` | Script | Sugam_Customer_Visit_Form.gs (the setup script, already run once) |
| `WebApp` (or webapp.gs) | Script | WebApp.gs |
| `Index` | HTML | Index.html (field rep form) |
| `Admin` | HTML | Admin.html (admin panel) |
| `Approve` | HTML | Approve.html (RM, Head Costing and field rep outcome page) |
| `Tracker` | HTML | Tracker.html (Head Costing tracker with stage filters) |

After any code change: **Deploy > Manage deployments > pencil > Version: New version > Deploy**. The link stays the same.
Deployment settings: **Execute as: Me**, **Who has access: Anyone**.

The first time after this update, Google asks for permission again (the digest needs a time trigger). Approve it once.
Check **Project Settings > Time zone** is `(GMT+05:30) India Standard Time` so the digest goes at 2:00 pm and 5:00 pm IST.

## 2. Links

| Who | Link |
|---|---|
| Field rep | `<web app URL>` |
| Admin | `<web app URL>?page=admin` (PIN = Settings > ADMIN_PIN) |
| Head Costing tracker | Admin > Approvals & mails > tracker link (`?page=tracker&k=...`) |
| RM / Head Costing / field rep | Their own link inside each digest or mail (`?page=approve&t=...`) |

## 3. Who sends the mails
Every mail is sent from the Google account that deployed the web app ("Execute as: Me"), never from the
field rep's account (Google does not let a script send from someone else's address).
The inbox shows who acted, and Reply goes to that person:

| Mail | Shown as | Reply goes to |
|---|---|---|
| New visit to RM (instant mail) | "<field rep> via Sugam Onboarding" | Field rep |
| RM approved, to Head Costing (instant mail) | "<RM name> via Sugam Onboarding" | RM |
| HO rates / rejection to field rep | "Head Costing via Sugam Onboarding" (or the RM when the RM rejects) | Head Costing / RM |
| Digests | "Sugam Customer Onboarding" | Deployer |
Google limit: about 100 mails a day from a personal Gmail, about 1,500 from Google Workspace.

## 4. Flow

| # | Who | What happens | TAT |
|---|---|---|---|
| 1 | Field rep | Fills the form: name, Employee ID, customer, lanes (origin to many destinations / delivery points) with a suggested price per lane | - |
| 2 | Regional Manager of the customer zone | Approves or rejects each lane and gives the RM rate. Remark required when a lane is rejected. If every lane is rejected the visit stops here and the field rep is told | 2 days |
| 3 | Head Costing | Sees the field rep price and RM rate. Approves or rejects each lane the RM approved and gives the HO approved rate (empty = RM rate). Remark required when a lane is rejected | 2 days |
| 4 | Sheet | HO approved rates go into `Web_Responses` on the same Visit ID row | - |
| 5 | Field rep | Gets a mail with the HO approved rates, revisits the customer and records: Finalized / Pending at customer / Customer refused (reason required). Rates cannot be changed | 2 days |

Stages: Pending at RM, Rejected by RM, Pending at Head Costing, Rejected by Head Costing, Pending at Field Rep,
Pending at Customer, Customer Refused, Finalized. A pending stage past its TAT shows as overdue.

## 5. Digest mails (default 2:00 pm and 5:00 pm)
One list per person instead of one mail per visit. Nobody gets a mail when nothing is pending.
**Instant mail** (Admin > Approvals & mails, tick box): the RM gets a mail the moment a visit is submitted, and Head Costing
the moment the RM approves. Use it while testing; it works together with the digests or on its own.

| Goes to | Contains |
|---|---|
| Regional Manager | Visits pending at RM, own zones only |
| Head Costing | Visits pending at Head Costing, counts of every stage, tracker link |
| Field rep | Their visits with HO rates to discuss (pending at field rep / customer) |

Each row: Visit ID, field rep, Employee ID, customer, zone, potential, submitted date, days pending (red when overdue) and an Open link.
The field rep also gets an immediate mail when Head Costing approves (or a rejection mail when RM / Head Costing rejects).

## 6. Admin panel
- **Questions**: add, edit, delete and reorder questions. Sheet columns follow automatically.
- **Approvals & mails**: Head Costing email, CC, TAT days per level, digest on/off, digest times, **Send now**, tracker link, RM per zone.
- **Master data**: GR PNL data master link and tab; a copy of the zones and places is refreshed every hour in the background (hidden tab `Master_Cache`), so the form opens fast. Use Reload master now after a big change.

## 7. Sheet tabs
- `Web_Responses`: one row per visit, one column per question, then Stage, RM Status, RM Remark, RM At,
  HO Status, HO Approved Rates, HO Remark, HO At, Outcome, Outcome Remark, Outcome At.
- `Customer_Lanes`: one row per customer x origin > destination / delivery point: suggested price, RM decision and rate,
  HO decision and approved rate, Final Rate, Lane Status, Stage. Filter on Customer to see one customer's full split.
- `Visit_Tracker`: one row per visit: stage, stage since, due by, RM / HO / outcome details and link tokens.
- `Form_Config`, `Zone_Emails`, `Settings`, `Mail_Log`.

Old test tabs from earlier versions (`Approvals`, `Visit_Summary`, `Visit_Lanes`) are no longer used by the web form.
Delete the test rows in `Customer_Lanes` before going live so the new columns start clean.

## 8. Zones and places (GR PNL data master)
Settings `GR_MASTER_SHEET` (default: GR PNL mirror) and `GR_MASTER_TAB` (default `DASHBOARD_MASTER`).
Columns read: Origin Zone, Origin, Dest Zone, Destname, Delivery Point (spaces, underscores and case do not matter).
"UNSPECIFIED" values are skipped. If the master cannot be read, Admin shows the error and the built-in lane copy is used.

## 9. Things to remember
- Do not run `setup` again (it would create a new Google Form); the script stops it anyway.
- If a mail did not go, check `Mail_Log`; the reason is written there.
