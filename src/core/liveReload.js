'use strict';
// Tiny local live-reload server. Bound to 127.0.0.1 only, serves one script
// and one event stream, accepts nothing else. Add this to your dev layout:
//   <script src="http://127.0.0.1:35730/claude-studio-reload.js"></script>

const http = require('http');
const path = require('path');
const { vs, cfg, matchesAny } = require('../util');

const CLIENT = `(function(){
  if (window.__claudeStudioReload) return; window.__claudeStudioReload = true;
  var src = document.currentScript && document.currentScript.src;
  if (!src) return;
  var base = src.replace(/\\/claude-studio-reload\\.js.*$/, '');
  function connect(){
    var es = new EventSource(base + '/events');
    es.onmessage = function(e){
      var msg = {}; try { msg = JSON.parse(e.data); } catch(_) {}
      if (msg.type === 'css') {
        var links = document.querySelectorAll('link[rel="stylesheet"]');
        for (var i = 0; i < links.length; i++) {
          var u = new URL(links[i].href, location.href);
          u.searchParams.set('_cs', Date.now());
          links[i].href = u.toString();
        }
      } else if (msg.type === 'reload') {
        location.reload();
      }
    };
    es.onerror = function(){ es.close(); setTimeout(connect, 3000); };
  }
  connect();
})();`;

class LiveReload {
  constructor(context, log) {
    this.log = log;
    this.server = null;
    this.clients = new Set();
    this.timer = undefined;
    this.pendingCssOnly = true;
    context.subscriptions.push({ dispose: () => this.stop() });
    context.subscriptions.push(vs().workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('claudeStudio.liveReload')) this.sync();
    }));
    this.sync();
  }

  sync() {
    const vscode = vs();
    const want = cfg('liveReload').get('enabled', false) && vscode.workspace.isTrusted;
    const port = cfg('liveReload').get('port', 35730);
    if (want && (!this.server || this.port !== port)) { this.stop(); this.start(port); }
    if (!want) this.stop();
  }

  start(port) {
    this.port = port;
    const server = http.createServer((req, res) => {
      const host = String(req.headers.host || '').replace(/:\d+$/, '');
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(host) || req.method !== 'GET') {
        res.writeHead(403); res.end(); return;
      }
      const url = (req.url || '').split('?')[0];
      if (url === '/claude-studio-reload.js') {
        res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(CLIENT);
      } else if (url === '/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive',
          'Access-Control-Allow-Origin': '*',
        });
        res.write(': connected\n\n');
        this.clients.add(res);
        req.on('close', () => this.clients.delete(res));
      } else {
        res.writeHead(404); res.end();
      }
    });
    server.on('error', e => {
      this.log(`Live reload server could not start on port ${port}: ${e.message}`);
      vs().window.showWarningMessage(`Claude Studio: live reload couldn't use port ${port}. Change claudeStudio.liveReload.port.`);
      this.server = null;
    });
    server.listen(port, '127.0.0.1', () => this.log(`Live reload listening on http://127.0.0.1:${port}`));
    this.server = server;
  }

  stop() {
    for (const c of this.clients) { try { c.end(); } catch { /* gone */ } }
    this.clients.clear();
    if (this.server) { this.server.close(); this.server = null; }
  }

  /** Called for every file Claude (or the user) changes. */
  fileChanged(uri) {
    if (!this.server) return;
    const vscode = vs();
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    const rel = folder ? path.relative(folder.uri.fsPath, uri.fsPath) : uri.fsPath;
    if (!matchesAny(cfg('liveReload').get('watch', ['**/*.{php,html,css,js}']), rel, uri.fsPath)) return;
    const isCss = /\.css$/i.test(uri.fsPath);
    this.pendingCssOnly = this.pendingCssOnly && isCss;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      const data = JSON.stringify({ type: this.pendingCssOnly ? 'css' : 'reload' });
      for (const c of this.clients) { try { c.write(`data: ${data}\n\n`); } catch { /* gone */ } }
      this.pendingCssOnly = true;
    }, cfg('liveReload').get('delayMs', 400));
  }

  async copySnippet() {
    const vscode = vs();
    const port = cfg('liveReload').get('port', 35730);
    const snippet = `<script src="http://127.0.0.1:${port}/claude-studio-reload.js"></script>`;
    await vscode.env.clipboard.writeText(snippet);
    if (!cfg('liveReload').get('enabled', false)) {
      const pick = await vscode.window.showInformationMessage(
        'Snippet copied. Paste it into your local site\'s layout (before </body>). Live reload is currently off.', 'Turn on');
      if (pick) await cfg('liveReload').update('enabled', true, vscode.ConfigurationTarget.Global);
    } else {
      vscode.window.showInformationMessage('Snippet copied. Paste it into your local site\'s layout (before </body>), only on your dev copy.');
    }
  }
}

module.exports = { LiveReload, CLIENT };
