# New sheet - Apps Script

Code for the Apps Script project bound to the new Google Sheet
(Script ID `1w219ypvYKC9Xf_eepV7RvxhqShin7Ko-cxBHnzgt9zFWOAbZQFBrUsVQ`).

- Put `.gs` and `.html` files in this folder. Every push to `main` that changes them sends them to the
  sheet's Apps Script project (workflow `.github/workflows/new-sheet-deploy.yml`). A repo file replaces the
  live file with the same name; live files the repo does not have are left alone.
- To copy code written directly in the Apps Script editor into this folder:
  GitHub > Actions > "New sheet: deploy" > Run workflow > mode `pull`.
- `LIVE_PROJECT_FILES.txt` is written by the workflow: the files currently in the live project.
