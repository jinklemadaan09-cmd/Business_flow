// Copies the repo's .gs / .html files over the matching files of a cloned Apps Script project.
// A repo file replaces the live file with the same name (any case, any extension), so the
// project keeps its own file names and manifest, and live files the repo does not have stay.
// Usage: node tools/merge-apps-script.js <repo folder> <cloned project folder>
const fs = require('fs'), path = require('path');
const [src, live] = process.argv.slice(2);
const ALIASES = { sugam_customer_visit_form: ['code'] };   // repo name > older names in the project

const liveFiles = fs.readdirSync(live).filter(f => /\.(js|gs|html)$/.test(f));
const key = f => path.basename(f, path.extname(f)).toLowerCase();

fs.readdirSync(src).filter(f => /\.(gs|html)$/.test(f)).forEach(f => {
  const isHtml = f.endsWith('.html'), k = key(f), names = [k].concat(ALIASES[k] || []);
  const match = liveFiles.find(l => l.endsWith('.html') === isHtml && names.indexOf(key(l)) >= 0);
  const target = match || (isHtml ? f : path.basename(f, '.gs') + '.js');
  fs.writeFileSync(path.join(live, target), fs.readFileSync(path.join(src, f)));
  console.log(f + ' > ' + target + (match ? '' : ' (new file)'));
});
