# Agentic AI - Sugam Group

| Folder | What |
|---|---|
| `customer-visit-form/` | Customer onboarding web app on Google Apps Script: field rep form (journey steps 01-05, one origin to many destinations with a suggested price per lane), two-level approval (Regional Manager, then Head Costing) per lane, HO approved rates back to the field rep for the customer outcome, Head Costing tracker with stage filters, digest mails at 2:00 pm and 5:00 pm, admin panel. Places come from the GR PNL data master. See `SETUP_STEPS.md`. |
| `new-sheet/` | Apps Script for the new Google Sheet, deployed from GitHub on every push to main. See `new-sheet/README.md`. |
| `sugam-journey/` | Customer journey flowchart (visit to collection, 12 steps). |
| `lanes/` | Lane master: origin branches, destinations, lane targets. |
| `main.py` | Email classifier experiment (agree / disagree / review). |
