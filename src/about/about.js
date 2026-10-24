'use strict';
// About & credits page for Claude Studio by PM.

const { vs, escapeHtml } = require('../util');
const { page, handleMessages, webviewOptions } = require('../ui/webview');

const AUTHOR = {
  name: 'Pawan Mall',
  website: 'https://www.pawanmall.in/',
  pluginWebsite: 'https://www.webdevservices.in/',
  email: 'pawan.webmaster@gmail.com',
  mobile: '8826809995',
  github: 'https://github.com/MrPawanMall',
};

const PARTNER = {
  name: 'MyQRStudio',
  tagline: 'Create QR Codes That Do More.',
  url: 'https://myqrstudio.in/',
};

const RESOURCES = [
  { title: 'AI Tools', icon: '✨', main: '', links: [
    ['Free Text to Speech Pro', 'https://webdevservices.in/tools/text-to-speech/'],
    ['AI API Key Validator', 'https://webdevservices.in/tools/ai-key-validator/'],
    ['AI SEO Schema Generator', 'https://webdevservices.in/tools/ai-seo-schema-generator/'],
    ['WhatsApp Widget Generator', 'https://webdevservices.in/tools/whatsapp-widget-tool/'],
    ['Free Prompt Generator', 'https://webdevservices.in/tools/free-prompt-generator/'],
    ['Then & Now Hug', 'https://gemini.google.com/share/fe7179f568ae'],
  ] },
  { title: 'QR-Masters', icon: '▦', main: 'https://webdevservices.in/qr/', links: [
    ['Website URL', 'https://webdevservices.in/qr/tools/url'],
    ['WhatsApp', 'https://webdevservices.in/qr/tools/whatsapp'],
    ['vCard Profile', 'https://webdevservices.in/qr/tools/vcard'],
    ['Secure Wi-Fi', 'https://webdevservices.in/qr/tools/wifi'],
    ['YouTube Video', 'https://webdevservices.in/qr/tools/youtube'],
    ['App Store', 'https://webdevservices.in/qr/tools/appstore'],
    ['Fast Email', 'https://webdevservices.in/qr/tools/email'],
    ['Maps Location', 'https://webdevservices.in/qr/tools/maps'],
    ['Plain Text', 'https://webdevservices.in/qr/tools/text'],
  ] },
  { title: 'Tools', icon: '🛠', main: '', links: [
    ['Weather Widget Generator', 'https://webdevservices.in/app/widget/generator/weather.php'],
    ['Twitter Intent Generator', 'https://webdevservices.in/tools/twitter-intent-generator/'],
    ['Free Image Editor', 'https://webdevservices.in/demo/free-image-editor/'],
    ['Free Image Converter', 'https://webdevservices.in/demo/image-converter/'],
    ['Glassmorphism Generator', 'https://webdevservices.in/tools/glassmorphism-generator/'],
    ['SVG URL Encoder', 'https://webdevservices.in/svg-url-encoder/'],
    ['Duplicate Word Finder', 'https://webdevservices.in/tools/duplicate-word-finder/'],
    ['Age Calculator Tool', 'https://webdevservices.in/age-calculator-tool/'],
    ['Markdown PDF Generator', 'https://webdevservices.in/demo/Markdown-PDF-Generator'],
  ] },
  { title: 'WordPress Plugins', icon: 'Ⓦ', main: '', links: [
    ['AI SEO Engine', 'https://webdevservices.in/ai-seo-engine-wordpress-plugin/'],
    ['WDS Country Dropdown', 'https://webdevservices.in/wds-country-dropdown-wordpress-plugin-2025/'],
    ['CF7 International Telephone Input', 'https://webdevservices.in/cf7-international-telephone-input/'],
  ] },
  { title: 'Shop', icon: '🛒', main: '', links: [
    ['File Management System (FMS) for Efficient Business Operations', 'https://webdevservices.in/product/file-management-system-fms/'],
    ['Online Shipment Tracking & Trip Management Web App (CodeIgniter 4 + Bootstrap 5)', 'https://webdevservices.in/product/advanced-shipment-tracking-web-app/'],
  ] },
  { title: 'Live Cricket Scores', icon: '🏏', main: '', links: [
    ['Live Cricket Scores', 'https://webdevservices.in/live-score/cricket.php'],
  ] },
  { title: 'Categories', icon: '🗂', main: '', links: [
    ['Technology', 'https://webdevservices.in/category/technology/'],
    ['Search Engine Optimization', 'https://webdevservices.in/category/search-engine-optimization/'],
    ['Web Development', 'https://webdevservices.in/category/web-development/'],
    ['Language', 'https://webdevservices.in/category/language/'],
    ['Front-End Development', 'https://webdevservices.in/category/front-end-development/'],
    ['Artificial Intelligence', 'https://webdevservices.in/category/artificial-intelligence/'],
    ['Dynamic QR Generator', 'https://webdevservices.in/qr'],
    ['Web Design', 'https://webdevservices.in/category/web-design/'],
    ['Tutorials', 'https://webdevservices.in/category/tutorials/'],
    ["Beginner's Guides", 'https://webdevservices.in/category/beginners-guides/'],
  ] },
];

let panel = null;

function open(context) {
  const vscode = vs();
  if (panel) { panel.reveal(); return; }
  panel = vscode.window.createWebviewPanel('claudeStudio.about', 'About Claude Studio by PM', vscode.ViewColumn.Active, webviewOptions(context.extensionUri));
  panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'icon.png');
  const iconSrc = panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'icon.png'));
  const version = context.extension ? context.extension.packageJSON.version : '';
  const link = (label, url) => `<a data-href="${escapeHtml(url)}" href="#">${escapeHtml(label)}</a>`;
  const host = url => url.replace(/^https?:\/\//, '').replace(/\/$/, '');

  const body = `
<div class="top">
  <section class="card info">
    <div class="brand"><img src="${iconSrc}" alt="" width="56" height="56">
      <div><h1>Claude Studio by PM</h1><div class="muted">Version ${escapeHtml(version)}</div></div></div>
    <p class="muted">Auto-open, review, undo, upload, usage and skills for the Claude agent — in Antigravity, VS Code and Cursor.</p>
    <dl>
      <dt>Extension Name</dt><dd>Claude Studio by PM</dd>
      <dt>Author</dt><dd>${escapeHtml(AUTHOR.name)}</dd>
      <dt>Website</dt><dd>${link(host(AUTHOR.website), AUTHOR.website)}</dd>
      <dt>Plugin Website</dt><dd>${link(host(AUTHOR.pluginWebsite), AUTHOR.pluginWebsite)}</dd>
      <dt>Email</dt><dd>${link(AUTHOR.email, 'mailto:' + AUTHOR.email)}</dd>
      <dt>Mobile</dt><dd>${link(AUTHOR.mobile, 'tel:' + AUTHOR.mobile)}</dd>
      <dt>GitHub</dt><dd>${link('github.com/MrPawanMall', AUTHOR.github)}</dd>
    </dl>
    <div class="actions">
      <a class="btn secondary" data-href="${AUTHOR.github}/claude-studio">Source code</a>
      <a class="btn secondary" data-href="${AUTHOR.github}/claude-studio/issues">Report an issue</a>
    </div>
  </section>
  <section class="card partner">
    <span class="badge">🏆 Exclusive Partner</span>
    <h2>${escapeHtml(PARTNER.name)}</h2>
    <p class="tagline">${escapeHtml(PARTNER.tagline)}</p>
    <p>${link(PARTNER.url, PARTNER.url)}</p>
    <a class="btn hero" data-href="${PARTNER.url}">Visit ${escapeHtml(PARTNER.name)}</a>
  </section>
</div>
<h2 class="section">Other Tools and Resources</h2>
<div class="grid">
${RESOURCES.map(cat => `
  <section class="card">
    <h3><span aria-hidden="true">${escapeHtml(cat.icon)}</span> ${escapeHtml(cat.title)}</h3>
    ${cat.main ? `<p class="muted">Main website: ${link(cat.main, cat.main)}</p>` : ''}
    <ul>${cat.links.map(([l, u]) => `<li>${link(l, u)}</li>`).join('')}</ul>
  </section>`).join('')}
</div>
<p class="muted foot">© ${new Date().getFullYear()} Pawan Mall · MIT License · Not affiliated with or endorsed by Anthropic. "Claude" is a trademark of Anthropic, PBC.</p>`;

  const css = `
.top{display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));margin-bottom:26px}
.brand{display:flex;gap:14px;align-items:center;margin-bottom:8px}
.brand img{border-radius:12px}
dl{display:grid;grid-template-columns:max-content 1fr;gap:6px 18px;margin:14px 0}
dt{color:var(--vscode-descriptionForeground)}dd{margin:0}
.actions{display:flex;gap:8px;flex-wrap:wrap}
.partner{text-align:center;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px}
.partner h2{font-size:1.6em;margin:10px 0 0}
.tagline{font-size:1.1em;margin:4px 0}
.btn.hero{padding:10px 26px;font-size:1.05em;margin-top:8px}
.section{margin:6px 0 12px}
ul{margin:0;padding-left:18px}li{margin:3px 0}
.foot{margin-top:26px;font-size:.9em}`;

  panel.webview.html = page(panel.webview, { title: 'About Claude Studio by PM', body, css });
  const sub = handleMessages(panel.webview, {});
  panel.onDidDispose(() => { sub.dispose(); panel = null; });
}

module.exports = { open, AUTHOR, PARTNER, RESOURCES };
