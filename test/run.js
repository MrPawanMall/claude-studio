'use strict';
// Plain-Node unit tests for Claude Studio's logic (no editor needed).
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');
const stub = require('./vscode-stub');
const origLoad = Module._load;
Module._load = (req, ...rest) => (req === 'vscode' ? stub : origLoad(req, ...rest));

let passed = 0, failed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const util = require('../src/util');
const pricing = require('../src/usage/pricing');
const { UsageReader } = require('../src/usage/reader');
const cfgMod = require('../src/upload/config');
const sources = require('../src/skills/sources');
const { ChangeTracker } = require('../src/core/tracker');

// ---------- util ----------
test('diffLines finds separate edits', () => {
  const a = 'a\nb\nc\nd\ne\nf';
  assert.deepStrictEqual(util.diffLines(a, 'a\nB\nc\nd\nE\nf').lines, [1, 4]);
  assert.deepStrictEqual(util.diffLines(a, 'a\nb\nx\ny\nc\nd\ne\nf').lines, [2, 3]);
  const del = util.diffLines(a, 'a\nb\nd\ne\nf');
  assert.strictEqual(del.removed, 1);
  assert.strictEqual(del.added, 0);
  assert.strictEqual(util.diffLines(a, a).lines.length, 0);
});
test('diffLines counts added/removed', () => {
  const d = util.diffLines('1\n2\n3', '1\nX\nY\n3');
  assert.strictEqual(d.added, 2);
  assert.strictEqual(d.removed, 1);
});
test('glob exclude matching', () => {
  assert.ok(util.matchesAny(['**/vendor/**'], 'vendor/autoload.php'));
  assert.ok(util.matchesAny(['**/vendor/**'], 'app/vendor/x.php'));
  assert.ok(util.matchesAny(['**/*.log'], 'writable/logs/a.log'));
  assert.ok(util.matchesAny(['**/*.{php,css}'], 'a/b.css'));
  assert.ok(!util.matchesAny(['**/vendor/**'], 'app/Controllers/Offer.php'));
});
test('sftp-style ignore', () => {
  assert.ok(util.matchesIgnore(['.git'], '.git/config'));
  assert.ok(util.matchesIgnore(['node_modules'], 'a/node_modules/x.js'));
  assert.ok(util.matchesIgnore(['writable/cache'], 'writable/cache/x'));
  assert.ok(util.matchesIgnore(['*.log'], 'logs/x.log'));
  assert.ok(!util.matchesIgnore(['.git'], 'app/git.php'));
});
test('safeRelative blocks path escapes', () => {
  assert.strictEqual(util.safeRelative('../evil'), null);
  assert.strictEqual(util.safeRelative('a/../../evil'), null);
  assert.strictEqual(util.safeRelative('/etc/passwd'), null);
  assert.strictEqual(util.safeRelative('C:/Windows/x'), null);
  assert.strictEqual(util.safeRelative('a/b/./c.md'), 'a/b/c.md');
});
test('isInside', () => {
  assert.ok(util.isInside('/srv/www', '/srv/www/a/b', true));
  assert.ok(!util.isInside('/srv/www', '/srv/www2/a', true));
  assert.ok(!util.isInside('/srv/www', '/srv/www/../etc', true));
});
test('escapeHtml', () => {
  assert.strictEqual(util.escapeHtml('<img src=x onerror="a">'), '&lt;img src=x onerror=&quot;a&quot;&gt;');
});

// ---------- pricing ----------
test('pricing picks the right model', () => {
  assert.strictEqual(pricing.priceKey('claude-opus-5-5'), 'opus-5-5');
  assert.strictEqual(pricing.priceKey('claude-opus-5-20260101'), 'opus-5');
  assert.strictEqual(pricing.priceKey('claude-sonnet-4-6'), 'sonnet-4');
  assert.strictEqual(pricing.priceKey('claude-haiku-4-5-20251001'), 'haiku-4-5');
  assert.strictEqual(pricing.priceKey('claude-fable-5-1'), 'fable-5-1');
  assert.strictEqual(pricing.priceKey('something-else'), null);
});
test('cost calculation', () => {
  const c = pricing.costOf({ input_tokens: 1e6, output_tokens: 1e6, cache_read_input_tokens: 1e6, cache_creation_input_tokens: 1e6 }, 'claude-opus-5-5');
  assert.strictEqual(Math.round(c * 100) / 100, 4 + 20 + 0.2 + 5);
  const h = pricing.costOf({ input_tokens: 200000, output_tokens: 0 }, 'claude-haiku-5-5');
  assert.strictEqual(Math.round(h * 1000) / 1000, 0.1); // long-prompt tier 0.5/M
  const o = pricing.costOf({ input_tokens: 1e6 }, 'claude-opus-5-5', { 'opus-5-5': { input: 1 } });
  assert.strictEqual(o, 1);
});

// ---------- usage reader ----------
test('usage reader dedupes and sums', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-usage-'));
  const proj = path.join(dir, '-home-me-research');
  fs.mkdirSync(proj);
  const now = new Date().toISOString();
  const line = (rid, out) => JSON.stringify({ type: 'assistant', timestamp: now, cwd: '/home/me/research', requestId: rid,
    message: { id: 'm' + rid, model: 'claude-opus-5-5', usage: { input_tokens: 1000, output_tokens: out } } });
  fs.writeFileSync(path.join(proj, 's.jsonl'), [line('r1', 100), line('r1', 100), line('r2', 200), '{"type":"user"}', 'not json'].join('\n') + '\n');
  const r = new UsageReader(dir);
  r.refresh();
  const s = r.summary(['/home/me/research']);
  assert.strictEqual(s.today.requests, 2);
  assert.strictEqual(s.today.output, 300);
  assert.strictEqual(s.projectToday.requests, 2);
  // incremental append
  fs.appendFileSync(path.join(proj, 's.jsonl'), line('r3', 50) + '\n');
  r.refresh();
  assert.strictEqual(r.summary(['/home/me/research']).today.output, 350);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------- sftp config ----------
test('sftp.json parsing, profiles and remote paths', () => {
  const text = `// comment
  { "name": "Site", "host": "h.com", "username": "u", "password": "secret", "remotePath": "/public_html",
    "ignore": [".git", "writable/cache"], "uploadOnSave": true,
    "profiles": { "dev": { "remotePath": "/staging" }, "prod": { "remotePath": "/public_html", "password": "p2" } },
    "defaultProfile": "dev", }`;
  const raws = cfgMod.parseConfigText(text);
  assert.strictEqual(raws.length, 1);
  const c = cfgMod.resolveConfig(raws[0], '/proj', undefined);
  assert.strictEqual(c.profile, 'dev');
  assert.strictEqual(c.remotePath, '/staging');
  assert.strictEqual(c.port, 22);
  assert.strictEqual(cfgMod.remotePathFor(c, '/proj/app/Models/A.php'), '/staging/app/Models/A.php');
  assert.strictEqual(cfgMod.remotePathFor(c, '/proj/.git/config'), null);
  assert.strictEqual(cfgMod.remotePathFor(c, '/proj/writable/cache/x'), null);
  assert.strictEqual(cfgMod.remotePathFor(c, '/other/file.php'), null);
  const p = cfgMod.resolveConfig(raws[0], '/proj', 'prod');
  assert.strictEqual(p.remotePath, '/public_html');
  assert.strictEqual(p.password, 'p2');
});
test('sftp.json context cannot escape project', () => {
  assert.throws(() => cfgMod.resolveConfig({ host: 'h', context: '../../etc' }, '/proj'));
});
test('stripPasswords removes all passwords and keeps comments', () => {
  const text = '{\n  // keep me\n  "host": "h",\n  "password": "x",\n  "profiles": { "prod": { "password": "y", "remotePath": "/a" } }\n}';
  const out = cfgMod.stripPasswords(text);
  assert.ok(!out.includes('"password"'));
  assert.ok(out.includes('// keep me'));
  assert.ok(out.includes('"remotePath": "/a"'));
  JSON.parse(out.replace(/\/\/.*$/gm, ''));
});

// ---------- skills ----------
test('frontmatter parsing', () => {
  const fm = sources.parseFrontmatter('---\nname: my-skill\ndescription: "Does things"\n---\n# body');
  assert.strictEqual(fm.name, 'my-skill');
  assert.strictEqual(fm.description, 'Does things');
});
test('github input parsing', () => {
  assert.deepStrictEqual(sources.parseGithub('anthropics/skills'), { repo: 'anthropics/skills' });
  const g = sources.parseGithub('https://github.com/anthropics/skills/tree/main/skills');
  assert.strictEqual(g.repo, 'anthropics/skills');
  assert.strictEqual(g.branch, 'main');
  assert.strictEqual(g.path, 'skills');
  assert.strictEqual(sources.parseGithub('https://evil.com/a/b'), null);
});
test('zip skills: finds skills and blocks zip-slip', () => {
  const { zipSync, strToU8 } = require('fflate');
  const zip = zipSync({
    'pack/one/SKILL.md': strToU8('---\nname: one\ndescription: first\n---\n'),
    'pack/one/run.sh': strToU8('echo hi'),
    'pack/two/SKILL.md': strToU8('---\nname: two\n---\n'),
    '../../evil.txt': strToU8('nope'),
  });
  const skills = sources.listZipBuffer(Buffer.from(zip), { type: 'zipfile', name: 't.zip' });
  assert.strictEqual(skills.length, 2);
  const one = skills.find(s => s.name === 'one');
  assert.deepStrictEqual(one.files.map(f => f.rel).sort(), ['SKILL.md', 'run.sh']);
  assert.ok(sources.isRisky('run.sh'));
  assert.ok(!skills.some(s => s.files.some(f => f.rel.includes('evil'))));
});

// ---------- tracker ----------
test('tracker groups changes into tasks and keeps originals', () => {
  stub._config['claudeStudio.notifications.finishedAfterSeconds'] = 2;
  const t = new ChangeTracker();
  const u = stub.Uri.file('/p/a.php');
  t.snapshot(u, 'v1');
  t.record(u, 'v1', 'v2', false);
  t.record(u, 'v2', 'v3', false);
  const n = stub.Uri.file('/p/new.php');
  t.record(n, null, 'new', true);
  assert.strictEqual(t.tasks.length, 1);
  const plan = t.restorePlanForTask(t.tasks[0]);
  assert.deepStrictEqual(plan.map(p => p.content), ['v1', null]);
  assert.strictEqual(t.latestEntry(u).entry.lastBefore, 'v2');
  const cp = t.createCheckpoint('x');
  t.record(u, 'v3', 'v4', false);
  assert.strictEqual(t.restorePlanForCheckpoint(cp)[0].content, 'v3');
  t.markSelfWrite(u, 'v1');
  assert.ok(t.isSelfWrite(u, 'v1'));
  assert.ok(!t.isSelfWrite(u, 'v1'));
  t.dispose();
});

// ---------- every module loads ----------
test('all modules load', () => {
  const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.js') ? [path.join(d, e.name)] : []);
  for (const f of walk(path.join(__dirname, '..', 'src'))) require(f);
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { failed++; console.log(`  ✗ ${name}\n    ${e.stack.split('\n').slice(0, 3).join('\n    ')}`); }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
