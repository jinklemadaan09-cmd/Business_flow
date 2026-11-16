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

## Engine change (Main.gs, already done)
`writeMasterSheets_` now passes the rows through `GRA_mirrorFilter(headers, rows)` before writing
`DASHBOARD_MASTER`, so the engine never writes archived months back into the mirror.
Until the first archive exists the filter keeps every row, so nothing changes on merge alone.
The engine menu gets a sub-menu **Archive (6 mahine)**: Dry run, Archive abhi chalao, Setup.

## Deploy
The whole engine code is in this folder (pulled from the live Apps Script). Every push to `main` that
changes it sends it to the engine (`GR engine: sync`). Code edited in the Apps Script editor can be
saved back with Actions > GR engine: sync > mode pull.

## First time
1. Merge the PR: GitHub puts `Archive.gs` and the `Main.gs` change into the engine.
2. Reload the engine sheet > **GR PNL Engine > Archive (6 mahine) > Dry run**: `ARCHIVE_LOG` shows what
   would happen, nothing changes.
3. **Archive (6 mahine) > Setup** once (allow permissions), then **Archive abhi chalao** (or wait for 2 AM).
   Long runs continue on their own; the mail says when a half-year archive is ready.
