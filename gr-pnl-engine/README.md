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
   `FY26-27 H1 archive rebuilt. Reason: files re-read: Aug-26.xlsx; new columns: LHC_AMT.
   Rows 80,120 → 80,145 (+25) · GRs changed 312 · TOTAL FREIGHT 41,20,00,000 → 41,26,00,000`.
   The new file **replaces** the old one for the same period: one file per half-year, never two
   (the old one goes to Drive Trash, 30 days). Set `KEEP_OLD_VERSION = YES` to keep it in `GR_ARCHIVE/old` instead.
   Two runs can never write the same period at once.
5. **Self-healing** (end of every run, no click): keeps exactly one complete file set per period, fixes names,
   removes extra copies, unfinished `- building` leftovers and the `old/` folder, and rebuilds any period whose
   files are missing or whose row count is wrong. When everything is clean, ONE mail lists every period with
   its file link, rows and OK; it is sent again only when that list changes.
   **Archive (6 months) > Archive status** shows the same list on demand (optional).
4. **Mirror trim**: rows older than `KEEP_MONTHS` (6) leave the mirror tab, and only rows whose
   GR NO is in a verified archive. Rows not found in an archive stay.

Long runs stop at 4.5 minutes and continue on their own a minute later.
The archive never holds the engine's lock while it writes, so **Refresh now** and the hourly engine
refresh are never blocked by it. While the engine is still reading new or changed files, the archive
waits and tries again in 5 minutes. The first **Run archive now** (or Setup) installs the nightly 2 AM run;
from then on every finished half-year is archived without a click.

## Copy in Cloudflare R2 (for the dashboard website)
`R2.gs`: when R2 keys are saved, every verified half-year JSON that ended 45+ days ago (FY25-26 H1, H2 and FY26-27 H1 today) can be copied to a private Cloudflare R2
bucket (`archive/GR_MASTER_<period>.json.gz` + `archive/index.json`), only from the menu. The dashboard website reads it.
A failed upload is mailed; the Drive archive is never touched by it. Setup and the website side: README of the Dashboard repo.
Menu: **Archive (6 months) > Cloudflare R2: save keys / test connection / move ready half-years now (upload + freeze)**,
**Frozen half-years: status / take one back / take all back**.

**Old half-years leave the engine (freeze, manual).** R2 is never written by the nightly run. When a
half-year ended `FREEZE_AFTER_DAYS` (45) days ago and its archive is verified, the archive mails once:
"ready to move to Cloudflare R2". The owner then clicks **Archive (6 months) → Cloudflare R2: move ready
half-years now (upload + freeze)**. It first runs the archive against the engine data of right now
(a file changed after the nightly run is archived first), then uploads every ready half-year R2 does not
have with the same data, then freezes the ones R2 now has (archive verified, same hash, in `index.json`):
- the engine stops reading their GRs and the source files that hold only those months, and rebuilds
  without them (about 1 minute). That run reads every file once and counts each frozen half-year's GRs:
  a half-year whose count is not the archive's is taken back into the engine (mail), the others stay frozen;
- the website's first load is only the running half-year; the header shows
  **⚠ FY25-26 H1, FY25-26 H2, FY26-27 H1 not loaded [Load]**. Until Load is clicked, NBD, Uptrade /
  Downtrade, MoM and trends that use those months are incomplete. After Load the dashboard has the same
  GRs and the same numbers as before the freeze (tested). Each half-year is downloaded once per browser
  (IndexedDB) and read from there later.
- a new / changed source file with rows of a frozen half-year is **not applied**; a mail names it. To
  apply it: **Frozen half-years: take one back into the engine**, let the refresh and the archive run,
  then **move ready half-years now** again. **Frozen half-years: status** shows what is frozen.
- `FREEZE_ON = NO` in `ARCHIVE_SETTINGS` turns it off. The Apps Script link (no R2) shows only the
  months the engine still has.

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
The engine menu gets a sub-menu **Archive (6 months)**: Dry run, Run archive now, Setup. All sheet text, logs and mails are in English.

## Deploy
The whole engine code is in this folder (pulled from the live Apps Script). Every push to `main` that
changes it sends it to the engine (`GR engine: sync`). Code edited in the Apps Script editor can be
saved back with Actions > GR engine: sync > mode pull.

## First time
1. Merge the PR: GitHub puts `Archive.gs` and the `Main.gs` change into the engine.
2. Reload the engine sheet > **GR PNL Engine > Archive (6 months) > Dry run**: `ARCHIVE_LOG` shows what
   would happen, nothing changes.
3. **Archive (6 months) > Setup** once (allow permissions), then **Run archive now** (or wait for 2 AM).
   Long runs continue on their own; the mail says when a half-year archive is ready.

# Dashboard data folder (`DataFolders.gs`)

Everything the engine writes to Drive now lives in one folder, `GR_DASHBOARD_DATA`, away from the
P&L / DSR input folders:

| Inside `GR_DASHBOARD_DATA` | What |
|---|---|
| `GR_PNL_ENGINE_CACHE` | The JSON files the dashboard loads (`engine_state.json`, `dashboard_master_part_N.json`, `delta_*.json`, `cache_*.json`) |
| `GR_ARCHIVE` (+ `old`) | Half-year archive sheets and their gzip JSON copies |
| `GR_PNL_REPORTS` | Files users download from the dashboard |

- The folder is made next to the engine spreadsheet. If the spreadsheet itself sits inside an input
  folder, it is made in My Drive instead.
- On the first refresh after the merge, the existing folders are moved into it. Drive keeps a folder's
  id when it moves, and the engine finds every folder by id, so the dashboard and the 2-hourly refresh
  keep working. Menu: **GR PNL Engine > Dashboard data folder > Move engine files into GR_DASHBOARD_DATA now**
  does the same at once and shows the result.
- "Get data from folder" and **Check folders** never read these folders as input (they show as
  `SKIPPED: engine data folder`).
- If one of these folders is put in the Drive Trash by mistake, the engine takes it back out on its next run.

# Memory guard for big refreshes (Out of memory fix)
When several big files are replaced at once (e.g. DSR H1 + H2 + a P&L file), a normal refresh used to
load the old master, the new rows, every lookup file and a huge delta file together and stop with
**Out of memory**; the dashboard then stayed on the last good data. The refresh now:
- joins the base rows in batches of `JOIN_BATCH_ROWS` (20,000), turning each batch into plain rows before the next;
- loads a lookup joined on GR NO (like DSR) only for the GRs being built, and skips sources no join uses;
- builds a change of more than max(`BIG_CHANGE_MIN_KEYS`, 25% of the master) like **Rebuild master from cache**
  (no old master in memory, no huge delta; dashboards do one full reload), and writes the
  `DASHBOARD_MASTER` sheet in the follow-up run a minute later.
Every GR and every number stays the same as before; only memory use changes. Settings are in `Config.gs`.

# PROCESS_LOG self-check
PROCESS_LOG is only the human view; the real list of loaded files is the engine manifest (`engine_state.json`).
At the end of every refresh the engine now puts back a row for any loaded file whose PROCESS_LOG row was
deleted or cleared (marked "Row restored from engine"), and removes leftover rows that hold only a Status.
Status updates now write only the cells of the files concerned, never the whole column.
