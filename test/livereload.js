'use strict';
const Module = require('module'); const assert = require('assert'); const http = require('http');
const stub = require('./vscode-stub');
stub._config['claudeStudio.liveReload.enabled'] = true;
stub._config['claudeStudio.liveReload.port'] = 35999;
stub._config['claudeStudio.liveReload.delayMs'] = 10;
const orig = Module._load; Module._load = (r, ...a) => (r === 'vscode' ? stub : orig(r, ...a));
const { LiveReload } = require('../src/core/liveReload');
const lr = new LiveReload({ subscriptions: [] }, () => {});
const get = (p, host = '127.0.0.1:35999') => new Promise(res => http.get({ host: '127.0.0.1', port: 35999, path: p, headers: { Host: host } }, r => res(r)));
setTimeout(async () => {
  const js = await get('/claude-studio-reload.js'); assert.strictEqual(js.statusCode, 200);
  const evil = await get('/claude-studio-reload.js', 'evil.com'); assert.strictEqual(evil.statusCode, 403);
  const nf = await get('/etc/passwd'); assert.strictEqual(nf.statusCode, 404);
  const ev = await get('/events');
  let data = '';
  ev.on('data', d => { data += d; });
  lr.fileChanged(stub.Uri.file('/p/app/style.css'));
  setTimeout(() => {
    lr.fileChanged(stub.Uri.file('/p/app/Offer.php'));
    setTimeout(() => {
      assert.ok(data.includes('"type":"css"'), 'css-only reload'); assert.ok(data.includes('"type":"reload"'), 'full reload');
      console.log('  ✓ live reload: script, events, host check, css vs full reload'); lr.stop(); process.exit(0);
    }, 100);
  }, 100);
}, 200);
