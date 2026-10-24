'use strict';
// Shared, locked-down webview shell: strict CSP, nonce-only scripts, no remote
// code, and links opened through an allow-listed postMessage handler.

const { vs, nonce, isHttpsUrl } = require('../util');

const BASE_CSS = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground);
  background: var(--vscode-editor-background); margin: 0; padding: 20px 24px 40px; line-height: 1.5; }
h1 { font-size: 1.6em; margin: 0 0 4px; font-weight: 600; }
h2 { font-size: 1.15em; margin: 0 0 10px; font-weight: 600; }
h3 { font-size: 1em; margin: 0 0 8px; font-weight: 600; display: flex; gap: 6px; align-items: center; }
a { color: var(--vscode-textLink-foreground); text-decoration: none; cursor: pointer; }
a:hover { text-decoration: underline; }
.muted { color: var(--vscode-descriptionForeground); }
.card { background: var(--vscode-sideBar-background, var(--vscode-editorWidget-background));
  border: 1px solid var(--vscode-panel-border, var(--vscode-widget-border, transparent)); border-radius: 8px; padding: 16px; }
.grid { display: grid; gap: 14px; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); }
.row { display: flex; gap: 14px; flex-wrap: wrap; }
.btn { display: inline-block; padding: 6px 14px; border-radius: 4px; border: 1px solid var(--vscode-button-border, transparent);
  background: var(--vscode-button-background); color: var(--vscode-button-foreground); cursor: pointer; font: inherit; }
.btn:hover { background: var(--vscode-button-hoverBackground); text-decoration: none; }
.btn.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
.btn.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
table { border-collapse: collapse; width: 100%; }
th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,.25)); }
th { font-weight: 600; color: var(--vscode-descriptionForeground); }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
pre { white-space: pre-wrap; word-break: break-word; background: var(--vscode-textCodeBlock-background); padding: 12px; border-radius: 6px;
  font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); max-height: 60vh; overflow: auto; }
.badge { display: inline-block; padding: 1px 8px; border-radius: 10px; font-size: .85em;
  background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
.warn { color: var(--vscode-editorWarning-foreground); }
.err { color: var(--vscode-errorForeground); }
.ok { color: var(--vscode-testing-iconPassed, #3fb950); }
`;

/**
 * Builds a complete HTML page with a strict Content-Security-Policy.
 * `body` must already be escaped. `script` runs with a nonce.
 */
function page(webview, { title, body, css = '', script = '' }) {
  const n = nonce();
  const csp = [
    "default-src 'none'",
    `img-src ${webview.cspSource} data:`,
    `style-src ${webview.cspSource} 'nonce-${n}'`,
    `script-src 'nonce-${n}'`,
    `font-src ${webview.cspSource}`,
  ].join('; ');
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title>
<style nonce="${n}">${BASE_CSS}${css}</style>
</head><body>
${body}
<script nonce="${n}">
const vscodeApi = acquireVsCodeApi();
document.addEventListener('click', e => {
  const a = e.target.closest('[data-href],[data-cmd]');
  if (!a) return;
  e.preventDefault();
  if (a.dataset.href) vscodeApi.postMessage({ type: 'open', url: a.dataset.href });
  else vscodeApi.postMessage({ type: 'cmd', cmd: a.dataset.cmd, arg: a.dataset.arg });
});
${script}
</script>
</body></html>`;
}

/**
 * Handles messages from a webview. Only https/mailto/tel links and an explicit
 * allow-list of commands are accepted; everything else is ignored.
 */
function handleMessages(webview, allowedCommands = {}) {
  return webview.onDidReceiveMessage(async msg => {
    if (!msg || typeof msg !== 'object') return;
    const vscode = vs();
    if (msg.type === 'open' && typeof msg.url === 'string') {
      const url = msg.url;
      if (isHttpsUrl(url) || /^mailto:[^\s]+$/.test(url) || /^tel:[0-9+]+$/.test(url)) {
        vscode.env.openExternal(vscode.Uri.parse(url));
      }
    } else if (msg.type === 'cmd' && typeof msg.cmd === 'string' && Object.prototype.hasOwnProperty.call(allowedCommands, msg.cmd)) {
      try { await allowedCommands[msg.cmd](msg.arg, msg); } catch (e) { vscode.window.showErrorMessage(String(e.message || e)); }
    }
  });
}

function webviewOptions(extensionUri) {
  const vscode = vs();
  return {
    enableScripts: true,
    enableCommandUris: false,
    localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
  };
}

module.exports = { page, handleMessages, webviewOptions };
