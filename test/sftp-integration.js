'use strict';
// Integration test: uploads and downloads through Claude Studio's Connection
// class against a real (in-process) SSH/SFTP server, including host-key checks.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert');
const { Server, utils: { sftp: { STATUS_CODE, OPEN_MODE } } } = require('ssh2');
const { Connection } = require('../src/upload/client');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-sftp-root-'));
const local = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-sftp-local-'));
const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const hostKey = require('ssh2').utils.parseKey(privateKey);
const resolve = p => path.join(root, path.posix.normalize('/' + p));

const server = new Server({ hostKeys: [privateKey] }, client => {
  client.on('error', () => {});
  client.on('authentication', ctx => (ctx.method === 'password' && ctx.username === 'pm' && ctx.password === 'pw' ? ctx.accept() : ctx.reject(['password'])));
  client.on('ready', () => client.on('session', accept => accept().on('sftp', acc => {
    const sftp = acc();
    const handles = new Map(); let hid = 0;
    const statAttrs = st => ({ mode: st.mode, uid: 0, gid: 0, size: st.size, atime: st.atimeMs / 1000 | 0, mtime: st.mtimeMs / 1000 | 0 });
    sftp.on('OPEN', (id, file, flags) => {
      try {
        const fd = fs.openSync(resolve(file), flags & OPEN_MODE.WRITE ? 'w' : 'r');
        const h = Buffer.alloc(4); h.writeUInt32BE(++hid); handles.set(hid, fd); sftp.handle(id, h);
      } catch { sftp.status(id, STATUS_CODE.NO_SUCH_FILE); }
    });
    sftp.on('WRITE', (id, h, offset, data) => { fs.writeSync(handles.get(h.readUInt32BE()), data, 0, data.length, offset); sftp.status(id, STATUS_CODE.OK); });
    sftp.on('READ', (id, h, offset, len) => {
      const buf = Buffer.alloc(len); const n = fs.readSync(handles.get(h.readUInt32BE()), buf, 0, len, offset);
      n ? sftp.data(id, buf.subarray(0, n)) : sftp.status(id, STATUS_CODE.EOF);
    });
    sftp.on('FSTAT', (id, h) => sftp.attrs(id, statAttrs(fs.fstatSync(handles.get(h.readUInt32BE())))));
    sftp.on('CLOSE', (id, h) => { const k = h.readUInt32BE(); if (handles.has(k)) { try { fs.closeSync(handles.get(k)); } catch {} handles.delete(k); } sftp.status(id, STATUS_CODE.OK); });
    const stat = (id, p) => { try { sftp.attrs(id, statAttrs(fs.statSync(resolve(p)))); } catch { sftp.status(id, STATUS_CODE.NO_SUCH_FILE); } };
    sftp.on('STAT', stat); sftp.on('LSTAT', stat);
    sftp.on('MKDIR', (id, p) => { try { fs.mkdirSync(resolve(p)); sftp.status(id, STATUS_CODE.OK); } catch { sftp.status(id, STATUS_CODE.FAILURE); } });
    sftp.on('REALPATH', (id, p) => sftp.name(id, [{ filename: path.posix.normalize('/' + p), longname: '', attrs: {} }]));
  })));
});

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const fpReal = 'SHA256:' + crypto.createHash('sha256').update(hostKey.getPublicSSH()).digest('base64').replace(/=+$/, '');
  let seenFp = null;
  const config = { protocol: 'sftp', host: '127.0.0.1', port, username: 'pm', connectTimeout: 5000 };

  // 1. trusted host: upload into a new nested folder, then download
  fs.writeFileSync(path.join(local, 'Offer.php'), '<?php echo "hi";');
  const conn = new Connection(config, { password: 'pw' }, { hostVerifier: async (h, p, fp) => { seenFp = fp; return true; } });
  await conn.upload(path.join(local, 'Offer.php'), '/public_html/app/Controllers/Offer.php');
  assert.strictEqual(fs.readFileSync(path.join(root, 'public_html/app/Controllers/Offer.php'), 'utf8'), '<?php echo "hi";');
  assert.strictEqual(seenFp, fpReal, 'fingerprint matches server key');
  await conn.download('/public_html/app/Controllers/Offer.php', path.join(local, 'back.php'));
  assert.strictEqual(fs.readFileSync(path.join(local, 'back.php'), 'utf8'), '<?php echo "hi";');
  // second upload reuses the connection
  fs.writeFileSync(path.join(local, 'Offer.php'), '<?php echo "v2";');
  await conn.upload(path.join(local, 'Offer.php'), '/public_html/app/Controllers/Offer.php');
  assert.strictEqual(fs.readFileSync(path.join(root, 'public_html/app/Controllers/Offer.php'), 'utf8'), '<?php echo "v2";');
  await conn.close();
  console.log('  ✓ SFTP upload, nested mkdir, download, connection reuse');

  // 2. rejected host key: must not upload
  const bad = new Connection(config, { password: 'pw' }, { hostVerifier: async () => false });
  await assert.rejects(bad.upload(path.join(local, 'Offer.php'), '/evil.php'));
  assert.ok(!fs.existsSync(path.join(root, 'evil.php')));
  console.log('  ✓ untrusted host key blocks the upload');

  // 3. wrong password
  const wrong = new Connection(config, { password: 'nope' }, { hostVerifier: async () => true });
  await assert.rejects(wrong.upload(path.join(local, 'Offer.php'), '/x.php'));
  console.log('  ✓ wrong password is rejected');

  server.close();
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(local, { recursive: true, force: true });
  console.log('SFTP integration passed');
  process.exit(0);
})().catch(e => { console.error('FAILED', e); process.exit(1); });
