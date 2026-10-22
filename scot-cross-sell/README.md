# SCOT > Cross Sell FMS (Apps Script)

Bound to the **SCOT MeCA Sugam** Google Sheet (Script ID `1E_CP5PBG3_AnREyMKPOptXkZ2dR-51Ds_DSkOPDz0w6o-jMx-FlQZkC1`).

## What it does
When an SC writes a name in **"Visit Align to FS (if Yes pls mention name)"** on any `SCOT - <SC>` tab,
that client row is appended to **field team & SC FMS for cross sell** (only the mapped columns:
SC name, client, contact, mobile, product, origin, destination, email, avg business, FSR name, FSR email)
and, when mail is ON, a mail goes to the FS mail ID in **FS Email ID** (plus any CC).
Mail starts **OFF (on hold)**: rows still move and are logged as held. Admin menu **Mail ON / OFF** switches it;
**Send held mails** sends the ones held while it was off.

- No duplicates: the same SC + client + origin + destination is one FMS row. If the SCOT row changes later
  (for example the FS mail ID is added), the mapped cells of that FMS row are refreshed. The SC's own
  Pln / Act / CN columns are never touched.
- No FS mail ID yet: the row still moves; the mail goes out once a mail ID is filled.
- Runs on every edit, plus a background sync every 15 minutes for pasted or formula values.
- A new `SCOT - <name>` tab is picked up automatically.

## Admin (everything is changeable without code, and hidden from everyone else)
Setup creates a separate spreadsheet **"Cross Sell FMS - Admin"** in the Drive of the person who runs it.
Only the mail IDs in `ADMIN_EMAILS` can open it, so SCs and other users of the SCOT sheet never see these tabs.

| Tab | What |
|---|---|
| `FMS_Settings` | Source tabs, target tab, trigger column, values that do not count as a name, extra required columns, duplicate check columns, mail on/off, CC, SC mail IDs, mail subject and first line, sync interval, admin mail IDs |
| `FMS_Column_Map` | Which SCOT column goes to which FMS column. Add a row to copy one more column (a missing FMS column is added at the end of the header row) |
| `FMS_Log` | One line per moved row: SCOT tab and row, FS name, when moved, when mailed |

Menu **Cross Sell FMS**: **Setup** (run once, and again after changing the sync interval), **Sync now**,
**Open admin settings**, **Give admin access to ADMIN_EMAILS** (shares the admin spreadsheet with exactly those people).

## First time
1. Merge to `main`: GitHub pushes `Code.gs` into the sheet's Apps Script.
2. Reload the sheet, then **Cross Sell FMS > Setup** and allow the permissions once.
   Rows already aligned are moved without mail; only new ones send mail.
3. To add another admin: put the mail ID in `ADMIN_EMAILS`, then **Cross Sell FMS > Give admin access to ADMIN_EMAILS**.

## Deploy
Every push to `main` that changes this folder sends the code to Apps Script
(`.github/workflows/scot-cross-sell-deploy.yml`). GitHub > Actions > "SCOT cross sell: deploy" > Run workflow
> mode `pull` copies code edited in the Apps Script editor back into this folder.
