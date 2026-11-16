# GR PNL Engine: half-year archive + sheet size guard

`Archive.gs` goes into the GR PNL Engine Apps Script project. It keeps the `DASHBOARD_MASTER`
mirror under Google's 10,000,000 cell limit without anyone doing manual cleanup.
The dashboard is not affected: it reads the engine JSON, which still holds every month.

## Every night (on its own)
1. **Size guard**: counts cells in the engine spreadsheet (and the mirror spreadsheet if separate).
   Mail at 70% (`WARN_PCT`) and URGENT mail at 85% (`URGENT_PCT`).
2. **Archive**: every finished half-year (Apr-Sep = H1, Oct-Mar = H2) is saved in Drive `GR_ARCHIVE`
   as its own Google Sheet (about 70 lakh cells, under the limit) plus a gzip JSON copy.
   The copy is read back and checked (row count, every GR NO and GR DT) before anything else happens.
3. **Corrections**: if an archived half-year's data changes (a month file replaced, a new join,
   a new column), that half-year is rebuilt. The old and new versions are compared and the result
   goes to the `ARCHIVE_CHANGES` tab and by mail, for example:
   `FY26-27 H1 dobara bana. Wajah: files dobara padhi gayi: Aug-26.xlsx; naye columns: LHC_AMT.
   Rows 80,120 → 80,145 (+25) · badle GR 312 · TOTAL FREIGHT 41,20,00,000 → 41,26,00,000`.
   The previous version stays in `GR_ARCHIVE/old` for 90 days (`KEEP_OLD_DAYS`).
4. **Mirror trim**: rows older than `KEEP_MONTHS` (6) leave the mirror tab, and only rows whose
   GR NO is in a verified archive. Rows not found in an archive stay.

Long runs stop at 4.5 minutes and continue on their own a minute later.

## Tabs it adds to the engine sheet
| Tab | What |
|---|---|
| `ARCHIVE_SETTINGS` | All settings (on/off, months to keep, mail IDs, warn %, folder). No code change needed. |
| `ARCHIVE_LOG` | One line per run: cells used, what was archived, rows trimmed |
| `ARCHIVE_CHANGES` | One line per archive built or rebuilt, with old vs new |
| `ARCHIVE_FILES` | Every archive file: half-year, link, rows, CURRENT / OLD |

## Engine hook (one line)
If the engine rewrites the whole mirror on each refresh, the trimmed rows come back. In the engine
code that writes `DASHBOARD_MASTER`, filter the rows first:

```js
rows = GRA_mirrorFilter(headers, rows);
```
The nightly run detects a refill and mails if this hook is missing.

## First time
1. Put the engine Script ID in `gr-pnl-engine/SCRIPT_ID.txt` (engine sheet > Extensions > Apps Script >
   Project Settings > IDs). GitHub then pulls the live engine code into this folder (`GR engine: sync`, mode pull).
2. After review, run **Actions > GR engine: sync > mode push** to put `Archive.gs` into the engine.
3. In the Apps Script editor run `GRA_dryRun` once: `ARCHIVE_LOG` shows what would happen, nothing changes.
4. Run `GRA_setup` once (allow permissions). From then on it runs every night at 2 AM.
