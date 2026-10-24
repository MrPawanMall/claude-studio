'use strict';
// Integration test: FTP upload (nested folders) + download against a local FTP server.
const fs = require('fs'); const os = require('os'); const path = require('path'); const assert = require('assert');
const { FtpSrv } = require('ftp-srv');
const { Connection } = require('../src/upload/client');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-ftp-root-'));
const local = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-ftp-local-'));
const port = 2121 + Math.floor(Math.random() * 500);
const srv = new FtpSrv({ url: `ftp://127.0.0.1:${port}`, pasv_url: '127.0.0.1', pasv_min: 30000, pasv_max: 30100, anonymous: false, log: { trace() {}, debug() {}, info() {}, warn() {}, error() {}, child() { return this; } } });
srv.on('login', ({ username, password }, resolve, reject) => (username === 'pm' && password === 'pw' ? resolve({ root }) : reject(new Error('bad login'))));
(async () => {
  await srv.listen();
  fs.writeFileSync(path.join(local, 'a.css'), 'body{}');
  const conn = new Connection({ protocol: 'ftp', host: '127.0.0.1', port, username: 'pm', connectTimeout: 5000 }, { password: 'pw' }, { hostVerifier: async () => true });
  await conn.upload(path.join(local, 'a.css'), '/public_html/assets/css/a.css');
  assert.strictEqual(fs.readFileSync(path.join(root, 'public_html/assets/css/a.css'), 'utf8'), 'body{}');
  await conn.upload(path.join(local, 'a.css'), '/public_html/b.css');
  assert.ok(fs.existsSync(path.join(root, 'public_html/b.css')));
  await conn.download('/public_html/assets/css/a.css', path.join(local, 'back.css'));
  assert.strictEqual(fs.readFileSync(path.join(local, 'back.css'), 'utf8'), 'body{}');
  await conn.close();
  const bad = new Connection({ protocol: 'ftp', host: '127.0.0.1', port, username: 'pm', connectTimeout: 5000 }, { password: 'x' }, {});
  await assert.rejects(bad.upload(path.join(local, 'a.css'), '/z.css'));
  console.log('  ✓ FTP upload, nested folders, download, wrong password');
  await srv.close(); fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(local, { recursive: true, force: true });
  process.exit(0);
})().catch(e => { console.error('FAILED', e); process.exit(1); });
