'use strict';
// Usage & cost: status bar, sidebar panel, budget / limit alerts, dashboard.

const path = require('path');
const os = require('os');
const { vs, cfg, NS, money, compact, duration, escapeHtml, timeAgo } = require('../util');
const { UsageReader } = require('./reader');
const { fetchRateLimits } = require('./rateLimit');
const { page, handleMessages, webviewOptions } = require('../ui/webview');

function bar(frac, width = 8) {
  const f = Math.round(Math.max(0, Math.min(1, frac || 0)) * width);
  return '[' + 'X'.repeat(f) + '.'.repeat(width - f) + ']';
}
function pct(frac) {
  return `${Math.round((frac || 0) * 100)}%`;
}

class Usage {
  constructor(context, { notify, log }) {
    const vscode = vs();
    this.context = context;
    this.notify = notify;
    this.log = log;
    this.reader = new UsageReader(this.dir());
    this.summary = null;
    this.limits = context.globalState.get('cs.limits') || null;
    this.limitsError = '';
    this.fetching = false;
    this.panel = null;
    this.alerted = context.globalState.get('cs.alerts', {});

    this._onDidChange = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChange.event;

    this.status = vscode.window.createStatusBarItem(`${NS}.usage`, vscode.StatusBarAlignment.Right, 98);
    this.status.name = 'Claude Studio: Usage';
    this.status.command = `${NS}.usage.dashboard`;

    context.subscriptions.push(this._onDidChange, this.status,
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration(`${NS}.usage.pricing`)) { this.reader.reprice(this.overrides()); this.update(); }
        else if (e.affectsConfiguration(`${NS}.usage`)) { this.reader.setDir(this.dir()); this.restartTimer(); this.update(); }
      }),
      { dispose: () => clearInterval(this.timer) });

    this.restartTimer();
    setTimeout(() => { this.update(); this.maybeAskConsent(); }, 1500);
  }

  dir() {
    const custom = cfg('usage').get('projectsDirectory', '');
    return custom || path.join(os.homedir(), '.claude', 'projects');
  }

  overrides() {
    return cfg('usage').get('pricing', {}) || {};
  }

  restartTimer() {
    clearInterval(this.timer);
    const secs = Math.max(15, cfg('usage').get('refreshSeconds', 30));
    this.timer = setInterval(() => this.update(), secs * 1000);
  }

  async maybeAskConsent() {
    const vscode = vs();
    if (!cfg('usage').get('enabled', true)) return;
    if (this.context.globalState.get('cs.askedLimits')) return;
    if (!this.summary || !this.summary.hasData) return;
    await this.context.globalState.update('cs.askedLimits', true);
    const pick = await vscode.window.showInformationMessage(
      'Claude Studio can show your 5-hour and 7-day plan usage (like 5h: 12%). To do this it sends a tiny 1-token request to Anthropic with your Claude Code login every few minutes while you are working. Turn it on?',
      'Turn on', 'Not now');
    if (pick === 'Turn on') {
      await cfg('usage').update('showPlanLimits', true, vscode.ConfigurationTarget.Global);
      this.update(true);
    }
  }

  async update(forceLimits = false) {
    if (!cfg('usage').get('enabled', true)) { this.status.hide(); return; }
    const vscode = vs();
    try {
      this.reader.refresh(this.overrides());
      const folders = (vscode.workspace.workspaceFolders || []).map(f => f.uri.fsPath);
      this.summary = this.reader.summary(folders);
    } catch (e) {
      this.log(`Usage read failed: ${e.message}`);
    }
    await this.maybeFetchLimits(forceLimits);
    this.render();
    this.checkAlerts();
    this._onDidChange.fire();
    if (this.panel) this.panel.webview.html = this.dashboardHtml(this.panel.webview);
  }

  async maybeFetchLimits(force) {
    if (!cfg('usage').get('showPlanLimits', false) || this.fetching) return;
    const ttl = Math.max(60, cfg('usage').get('planLimitsIntervalSeconds', 300)) * 1000;
    const age = this.limits ? Date.now() - (this.limits.time || 0) : Infinity;
    const active = this.summary && Date.now() - this.summary.lastActivity < 15 * 60000;
    if (!force && (age < ttl || (!active && this.limits))) return;
    this.fetching = true;
    try {
      const r = await fetchRateLimits({
        credentialsPath: cfg('usage').get('credentialsPath', '') || undefined,
        model: cfg('usage').get('planLimitsModel', 'claude-haiku-5-5'),
      });
      if (r.error) { this.limitsError = r.error; }
      else {
        this.limits = r; this.limitsError = '';
        this.context.globalState.update('cs.limits', r);
      }
    } finally {
      this.fetching = false;
    }
  }

  projectName() {
    const vscode = vs();
    const f = vscode.workspace.workspaceFolders;
    return f && f.length ? f[0].name : 'project';
  }

  render() {
    const vscode = vs();
    const s = this.summary;
    if (!s) return;
    const mode = cfg('usage').get('statusBar', 'both');
    if (mode === 'off') { this.status.hide(); return; }
    const parts = [];
    const L = this.limits;
    if (L && cfg('usage').get('showPlanLimits', false) && mode !== 'cost') {
      parts.push(`5h:${pct(L.util5h)}${L.util5h >= 0.8 ? '⚠' : ''}`);
      if (L.util7d !== null && L.util7d !== undefined) parts.push(`7d:${pct(L.util7d)}${L.util7d >= 0.8 ? '⚠' : ''}`);
    }
    const left = parts.join(' ');
    const right = mode === 'percent' && left ? '' : `${this.projectName()}:${money(s.projectToday.cost)}`;
    this.status.text = `$(pulse) ${[left, right].filter(Boolean).join(' | ') || money(s.today.cost)}`;
    this.status.tooltip = this.tooltip();
    const warn = L && Math.max(L.util5h || 0, L.util7d || 0) >= 0.9;
    this.status.backgroundColor = warn ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    this.status.show();
  }

  tooltip() {
    const vscode = vs();
    const s = this.summary;
    const L = this.limits;
    const lines = ['Claude Code Usage', '──────────────────────────'];
    if (L && cfg('usage').get('showPlanLimits', false)) {
      const age = (Date.now() - L.time) / 1000;
      const r5 = Math.max(0, (L.reset5h || 0) - age);
      lines.push(`5h window:  ${pct(L.util5h).padStart(4)} ${bar(L.util5h)} resets in ${duration(r5)}`);
      if (L.util7d !== null && L.util7d !== undefined) {
        const r7 = Math.max(0, (L.reset7d || 0) - age);
        lines.push(`7d window:  ${pct(L.util7d).padStart(4)} ${bar(L.util7d)} resets in ${duration(r7)}`);
      }
      lines.push('');
    } else if (this.limitsError) {
      lines.push(`Plan limits: ${this.limitsError}`, '');
    }
    lines.push('Token Cost (local estimate)', '──────────────────────────');
    lines.push(`5h:   in:${compact(s.h5.input)} out:${compact(s.h5.output)}  ${money(s.h5.cost)}`);
    lines.push(`day:  ${money(s.today.cost)}`);
    lines.push(`7d:   ${money(s.d7.cost)}`);
    lines.push(`burn: ${money(s.burnPerHour)}/h (last 30 min)`);
    lines.push('');
    lines.push(`Project: ${this.projectName()}`);
    lines.push(`  Today: ${money(s.projectToday.cost)} | 7 days: ${money(s.project7d.cost)}`);
    lines.push('');
    lines.push(`Last updated: ${L ? timeAgo(L.time) : 'just now'}`);
    lines.push('Click to open dashboard →');
    const md = new vscode.MarkdownString('```text\n' + lines.join('\n') + '\n```');
    return md;
  }

  checkAlerts() {
    const s = this.summary;
    if (!s) return;
    const L = this.limits;
    const dayKey = new Date().toDateString();
    const fire = (key, n) => {
      if (this.alerted[key]) return;
      this.alerted[key] = Date.now();
      // keep the alert memory small
      const keys = Object.keys(this.alerted);
      if (keys.length > 60) keys.sort((a, b) => this.alerted[a] - this.alerted[b]).slice(0, keys.length - 60).forEach(k => delete this.alerted[k]);
      this.context.globalState.update('cs.alerts', this.alerted);
      this.notify(n);
    };

    const daily = cfg('usage').get('dailyBudget', 0);
    if (daily > 0) {
      if (s.today.cost >= daily) fire(`d100:${dayKey}`, { event: 'budgetAlert', level: 'error', title: 'Daily budget reached', message: `${money(s.today.cost)} of ${money(daily)} today` });
      else if (s.today.cost >= daily * 0.8) fire(`d80:${dayKey}`, { event: 'budgetAlert', title: '80% of daily budget used', message: `${money(s.today.cost)} of ${money(daily)}` });
    }
    const weekly = cfg('usage').get('weeklyBudget', 0);
    if (weekly > 0) {
      const wk = `${new Date().getFullYear()}-${Math.floor((Date.now() / 86400000 + 4) / 7)}`;
      if (s.d7.cost >= weekly) fire(`w100:${wk}`, { event: 'budgetAlert', level: 'error', title: 'Weekly budget reached', message: `${money(s.d7.cost)} in 7 days of ${money(weekly)}` });
      else if (s.d7.cost >= weekly * 0.8) fire(`w80:${wk}`, { event: 'budgetAlert', title: '80% of weekly budget used', message: `${money(s.d7.cost)} of ${money(weekly)}` });
    }
    if (L && cfg('usage').get('showPlanLimits', false)) {
      const th = cfg('usage').get('limitAlertPercent', 80) / 100;
      const window5 = Math.round((L.time / 1000 + (L.reset5h || 0)) / 600);
      if (L.util5h >= th) fire(`l5:${window5}:${th}`, { event: 'rateLimitAlert', title: `5-hour usage at ${pct(L.util5h)}`, message: `resets in ${duration(L.reset5h)}` });
      if (L.util7d !== null && L.util7d >= th) {
        const window7 = Math.round((L.time / 1000 + (L.reset7d || 0)) / 3600);
        fire(`l7:${window7}:${th}`, { event: 'rateLimitAlert', title: `7-day usage at ${pct(L.util7d)}`, message: `resets in ${duration(L.reset7d)}` });
      }
    }
  }

  // ---------- sidebar tree ----------
  getChildren() {
    const s = this.summary;
    if (!cfg('usage').get('enabled', true)) return [{ label: 'Usage tracking is off', icon: 'circle-slash', cmd: 'workbench.action.openSettings', args: ['claudeStudio.usage.enabled'] }];
    if (!s || !s.hasData) return [{ label: 'No Claude Code usage found yet', description: this.dir(), icon: 'info' }];
    const L = cfg('usage').get('showPlanLimits', false) ? this.limits : null;
    const items = [];
    if (L) {
      items.push({ label: '5-hour window', description: `${pct(L.util5h)} · resets in ${duration(L.reset5h - (Date.now() - L.time) / 1000)}`, icon: 'watch' });
      if (L.util7d !== null && L.util7d !== undefined) items.push({ label: '7-day window', description: `${pct(L.util7d)} · resets in ${duration(L.reset7d - (Date.now() - L.time) / 1000)}`, icon: 'calendar' });
    } else {
      items.push({ label: 'Show 5h / 7d plan usage…', icon: 'eye', cmd: `${NS}.usage.enablePlanLimits`, description: this.limitsError || 'off' });
    }
    items.push(
      { label: 'Last 5 hours', description: `${money(s.h5.cost)} · ${compact(s.h5.input + s.h5.output)} tokens`, icon: 'history' },
      { label: 'Today', description: money(s.today.cost), icon: 'calendar' },
      { label: 'Last 7 days', description: money(s.d7.cost), icon: 'graph' },
      { label: `Project: ${this.projectName()}`, description: `today ${money(s.projectToday.cost)} · 7d ${money(s.project7d.cost)}`, icon: 'folder' },
      { label: 'Burn rate', description: `${money(s.burnPerHour)}/hour`, icon: 'flame' },
      { label: 'Open dashboard', icon: 'dashboard', cmd: `${NS}.usage.dashboard` },
    );
    return items;
  }

  getTreeItem(i) {
    const vscode = vs();
    const t = new vscode.TreeItem(i.label);
    t.description = i.description;
    t.iconPath = new vscode.ThemeIcon(i.icon || 'circle-small');
    if (i.cmd) t.command = { command: i.cmd, title: i.label, arguments: i.args || [] };
    return t;
  }

  async enablePlanLimits() {
    const vscode = vs();
    const pick = await vscode.window.showInformationMessage(
      'Show 5-hour / 7-day plan usage? Claude Studio will send a tiny 1-token request to Anthropic with your Claude Code login every few minutes while you work (costs a tiny fraction of your limit). This uses undocumented headers and may stop working.',
      { modal: true }, 'Turn on');
    if (pick !== 'Turn on') return;
    await cfg('usage').update('showPlanLimits', true, vscode.ConfigurationTarget.Global);
    await this.update(true);
  }

  // ---------- dashboard ----------
  openDashboard(extensionUri) {
    const vscode = vs();
    if (this.panel) { this.panel.reveal(); return; }
    this.panel = vscode.window.createWebviewPanel('claudeStudio.dashboard', 'Claude Usage', vscode.ViewColumn.Active, webviewOptions(extensionUri));
    this.panel.iconPath = vscode.Uri.joinPath(extensionUri, 'media', 'icon.png');
    this.panel.webview.html = this.dashboardHtml(this.panel.webview);
    const sub = handleMessages(this.panel.webview, {
      refresh: () => this.update(true),
      settings: () => vscode.commands.executeCommand('workbench.action.openSettings', 'claudeStudio.usage'),
    });
    this.panel.onDidDispose(() => { sub.dispose(); this.panel = null; });
  }

  dashboardHtml(webview) {
    const s = this.summary;
    if (!s || !s.hasData) {
      return page(webview, { title: 'Claude Usage', body: `<h1>Claude Usage</h1><p class="muted">No Claude Code usage found in ${escapeHtml(this.dir())}.</p>` });
    }
    const L = cfg('usage').get('showPlanLimits', false) ? this.limits : null;
    const card = (title, value, sub) => `<div class="card"><div class="muted">${escapeHtml(title)}</div><div class="big">${escapeHtml(value)}</div><div class="muted">${escapeHtml(sub || '')}</div></div>`;
    const meter = (label, frac, reset) => `<div class="card"><div class="muted">${escapeHtml(label)}</div><div class="big">${pct(frac)}</div>
      <svg class="meter" viewBox="0 0 100 8" preserveAspectRatio="none"><rect class="track" x="0" y="0" width="100" height="8" rx="4"/><rect class="fill ${frac >= 0.9 ? 'hot' : frac >= 0.75 ? 'warm' : ''}" x="0" y="0" width="${Math.round(Math.min(1, Math.max(0, frac)) * 100)}" height="8" rx="4"/></svg>
      <div class="muted">resets in ${escapeHtml(duration(reset))}</div></div>`;

    // 30-day bars
    const days = [];
    const start = new Date(); start.setHours(0, 0, 0, 0);
    for (let i = 29; i >= 0; i--) {
      const d = new Date(start.getTime() - i * 86400000);
      days.push({ d, v: s.byDay.get(d.getTime()) || 0 });
    }
    const maxV = Math.max(0.01, ...days.map(x => x.v));
    const W = 720, H = 180, bw = W / days.length;
    const bars = days.map((x, i) => {
      const h = Math.max(x.v > 0 ? 2 : 0, (x.v / maxV) * (H - 30));
      const label = `${x.d.toLocaleDateString()}: ${money(x.v)}`;
      return `<rect x="${(i * bw + 2).toFixed(1)}" y="${(H - 20 - h).toFixed(1)}" width="${(bw - 4).toFixed(1)}" height="${h.toFixed(1)}" rx="2"><title>${escapeHtml(label)}</title></rect>` +
        (i % 5 === 4 || i === 29 ? `<text x="${(i * bw + bw / 2).toFixed(1)}" y="${H - 5}" text-anchor="middle">${x.d.getDate()}/${x.d.getMonth() + 1}</text>` : '');
    }).join('');
    const maxH = Math.max(0.01, ...s.byHour);
    const hours = `<svg viewBox="0 0 720 54" class="chart" role="img" aria-label="Cost by hour">` + s.byHour.map((v, h) =>
      `<rect class="hr" x="${h * 30 + 1}" y="0" width="28" height="36" rx="3" fill-opacity="${(0.12 + 0.88 * v / maxH).toFixed(2)}"><title>${h}:00 — ${money(v)}</title></rect><text x="${h * 30 + 15}" y="50" text-anchor="middle">${h}</text>`).join('') + '</svg>';

    const models = [...s.byModel.entries()].sort((a, b) => b[1].cost - a[1].cost)
      .map(([m, t]) => `<tr><td>${escapeHtml(m)}</td><td class="num">${t.requests}</td><td class="num">${compact(t.input + t.cacheRead + t.cacheWrite)}</td><td class="num">${compact(t.output)}</td><td class="num">${money(t.cost)}</td></tr>`).join('');
    const projects = [...s.byProject.entries()].sort((a, b) => b[1].cost - a[1].cost).slice(0, 15)
      .map(([p, t]) => `<tr><td title="${escapeHtml(t.path || '')}">${escapeHtml(p)}</td><td class="num">${t.requests}</td><td class="num">${money(t.cost)}</td></tr>`).join('');
    const cacheShare = s.d7.cacheRead / Math.max(1, s.d7.input + s.d7.cacheRead + s.d7.cacheWrite);

    const body = `
<div class="head"><div><h1>Claude Usage</h1><div class="muted">Claude Studio by PM · costs are local estimates from Anthropic's published prices</div></div>
<div><a class="btn secondary" data-cmd="settings">Settings</a> <a class="btn" data-cmd="refresh">Refresh</a></div></div>
<div class="grid">
${L ? meter('5-hour window', L.util5h, L.reset5h - (Date.now() - L.time) / 1000) : ''}
${L && L.util7d !== null && L.util7d !== undefined ? meter('7-day window', L.util7d, L.reset7d - (Date.now() - L.time) / 1000) : ''}
${card('Last 5 hours', money(s.h5.cost), `${compact(s.h5.input)} in · ${compact(s.h5.output)} out`)}
${card('Today', money(s.today.cost), `${s.today.requests} requests`)}
${card('Last 7 days', money(s.d7.cost), `cache hits ${Math.round(cacheShare * 100)}% of input`)}
${card(`Project · ${this.projectName()}`, money(s.projectToday.cost), `7 days: ${money(s.project7d.cost)}`)}
${card('Burn rate', `${money(s.burnPerHour)}/h`, 'based on the last 30 minutes')}
${card('Last 30 days', money(s.d30.cost), `${s.d30.requests} requests`)}
</div>
<div class="card wide"><h2>Daily cost — last 30 days</h2><svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="Daily cost chart">${bars}</svg></div>
<div class="card wide"><h2>When you use Claude (cost by hour, 30 days)</h2>${hours}</div>
<div class="row2">
<div class="card"><h2>By model (30 days)</h2><table><tr><th>Model</th><th class="num">Requests</th><th class="num">Input</th><th class="num">Output</th><th class="num">Cost</th></tr>${models}</table></div>
<div class="card"><h2>By project (30 days)</h2><table><tr><th>Project</th><th class="num">Requests</th><th class="num">Cost</th></tr>${projects}</table></div>
</div>`;
    const css = `
.head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap;margin-bottom:18px}
.big{font-size:1.7em;font-weight:600;margin:4px 0;font-variant-numeric:tabular-nums}
.grid{grid-template-columns:repeat(auto-fill,minmax(190px,1fr));margin-bottom:14px}
.wide{margin-bottom:14px}
.chart{width:100%;height:auto}
.chart rect{fill:var(--vscode-charts-blue,#3794ff)}
.chart text{fill:var(--vscode-descriptionForeground);font-size:10px}
.meter{width:100%;height:8px;margin:6px 0;display:block}
.meter .track{fill:rgba(128,128,128,.25)}
.meter .fill{fill:var(--vscode-charts-green,#3fb950)}
.meter .fill.warm{fill:var(--vscode-charts-yellow,#d29922)}
.meter .fill.hot{fill:var(--vscode-charts-red,#f85149)}
.chart rect.hr{fill:var(--vscode-charts-purple,#a371f7)}
.row2{display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(320px,1fr))}`;
    return page(webview, { title: 'Claude Usage', body, css });
  }
}

module.exports = { Usage };
