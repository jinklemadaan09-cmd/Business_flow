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

// Report: every file in the project and any function defined in more than one file
// (Apps Script uses the last one loaded, so an old copy can silently override new code).
const report = [], seen = {};
fs.readdirSync(live).filter(f => /\.(js|gs)$/.test(f)).forEach(f => {
  const code = fs.readFileSync(path.join(live, f), 'utf8');
  report.push(f + '  (' + code.length + ' chars)');
  (code.match(/^function\s+([A-Za-z0-9_$]+)\s*\(/gm) || []).forEach(m => {
    const n = m.replace(/^function\s+/, '').replace(/\s*\($/, '');
    (seen[n] = seen[n] || []).push(f);
  });
});
fs.readdirSync(live).filter(f => /\.html$/.test(f)).forEach(f => report.push(f));
const dup = Object.keys(seen).filter(n => seen[n].length > 1).map(n => n + ': ' + seen[n].join(', '));
report.push('', 'Functions defined in more than one file: ' + (dup.length ? '' : 'none'));
dup.forEach(d => report.push('  ' + d));
fs.writeFileSync(process.env.REPORT || '/dev/null', report.join('\n') + '\n');
console.log(report.join('\n'));
