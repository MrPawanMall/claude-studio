'use strict';
// Writes THIRD_PARTY_NOTICES.md with the licenses of every bundled dependency.
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const seen = new Map();
function walk(name) {
  if (seen.has(name)) return;
  const dir = path.join(root, 'node_modules', name);
  let pkg;
  try { pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch { return; }
  const licFile = fs.readdirSync(dir).find(f => /^(licen[cs]e|copying)(\.|$)/i.test(f));
  seen.set(name, { version: pkg.version, license: pkg.license || '(see file)', text: licFile ? fs.readFileSync(path.join(dir, licFile), 'utf8').trim() : '', repo: (pkg.repository && (pkg.repository.url || pkg.repository)) || '' });
  for (const dep of Object.keys(pkg.dependencies || {})) walk(dep);
}
const own = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
Object.keys(own.dependencies || {}).forEach(walk);
let out = '# Third-party notices\n\nClaude Studio by PM bundles the following open-source packages.\n';
for (const [name, i] of [...seen].sort()) {
  out += `\n## ${name} ${i.version}\n\nLicense: ${i.license}${i.repo ? `  \nSource: ${i.repo}` : ''}\n\n${i.text ? '```\n' + i.text + '\n```\n' : ''}`;
}
fs.writeFileSync(path.join(root, 'THIRD_PARTY_NOTICES.md'), out);
console.log(`THIRD_PARTY_NOTICES.md: ${seen.size} packages`);
