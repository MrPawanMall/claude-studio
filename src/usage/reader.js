'use strict';
// Reads Claude Code's local session logs (~/.claude/projects/**/*.jsonl)
// incrementally and turns them into token and cost totals. Nothing is sent
// anywhere: this is local file reading only.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { costOf, priceKey } = require('./pricing');

const KEEP_DAYS = 90;
const MAX_FILES = 5000;

class UsageReader {
  constructor(dir) {
    this.dir = dir || path.join(os.homedir(), '.claude', 'projects');
    /** file -> { size, mtimeMs, offset, rest } */
    this.files = new Map();
    /** dedupe key -> entry */
    this.entries = new Map();
    this.lastActivity = 0;
  }

  setDir(dir) {
    if (dir && dir !== this.dir) {
      this.dir = dir;
      this.files.clear();
      this.entries.clear();
    }
  }

  listJsonl() {
    const out = [];
    const walk = (d, depth) => {
      if (depth > 4 || out.length > MAX_FILES) return;
      let names;
      try { names = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const n of names) {
        const p = path.join(d, n.name);
        if (n.isDirectory()) walk(p, depth + 1);
        else if (n.isFile() && n.name.endsWith('.jsonl')) out.push(p);
      }
    };
    walk(this.dir, 0);
    return out;
  }

  /** Reads new data from all logs. Cheap to call often. */
  refresh(overrides = {}) {
    const cutoff = Date.now() - KEEP_DAYS * 86400000;
    for (const file of this.listJsonl()) {
      let st;
      try { st = fs.statSync(file); } catch { continue; }
      if (st.mtimeMs < cutoff) continue;
      let rec = this.files.get(file);
      if (rec && rec.size === st.size && rec.mtimeMs === st.mtimeMs) continue;
      if (!rec || st.size < rec.offset) rec = { offset: 0, rest: '' };
      if (st.mtimeMs > this.lastActivity) this.lastActivity = st.mtimeMs;

      const len = st.size - rec.offset;
      if (len > 0) {
        const fd = fs.openSync(file, 'r');
        try {
          const buf = Buffer.alloc(len);
          fs.readSync(fd, buf, 0, len, rec.offset);
          const text = rec.rest + buf.toString('utf8');
          const lines = text.split('\n');
          rec.rest = lines.pop() || '';
          for (const line of lines) this.parseLine(line, overrides);
        } finally {
          fs.closeSync(fd);
        }
      }
      rec.offset = st.size;
      rec.size = st.size;
      rec.mtimeMs = st.mtimeMs;
      this.files.set(file, rec);
    }
    // drop old entries
    for (const [k, e] of this.entries) if (e.ts < cutoff) this.entries.delete(k);
  }

  parseLine(line, overrides) {
    if (!line || line.indexOf('"usage"') === -1) return;
    let obj;
    try { obj = JSON.parse(line); } catch { return; }
    if (!obj || obj.type !== 'assistant' || !obj.message || !obj.message.usage) return;
    const ts = Date.parse(obj.timestamp);
    if (!ts) return;
    // streaming writes several lines per response with the same usage; count once
    const key = obj.requestId || (obj.message.id ? `m:${obj.message.id}` : obj.uuid);
    if (!key) return;
    const u = obj.message.usage;
    const model = obj.message.model || '';
    if (model === '<synthetic>') return;
    this.entries.set(key, {
      ts,
      model,
      family: priceKey(model, overrides) || model,
      cwd: obj.cwd || '',
      input: u.input_tokens || 0,
      output: u.output_tokens || 0,
      cacheRead: u.cache_read_input_tokens || 0,
      cacheWrite: u.cache_creation_input_tokens || 0,
      cost: costOf(u, model, overrides),
    });
  }

  /** Recalculate costs after pricing changes. */
  reprice(overrides) {
    this.files.clear();
    this.entries.clear();
    this.refresh(overrides);
  }

  /**
   * @param {string[]} projectPaths  workspace folders (for project cost)
   */
  summary(projectPaths = []) {
    const now = Date.now();
    const h5 = now - 5 * 3600000;
    const d7 = now - 7 * 86400000;
    const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
    const today = midnight.getTime();
    const m30 = now - 30 * 60000;
    const norm = p => (process.platform === 'win32' ? p.toLowerCase() : p).replace(/[\\/]+$/, '');
    const projects = projectPaths.map(norm);
    const inProject = cwd => {
      const c = norm(cwd || '');
      return projects.some(p => c === p || c.startsWith(p + path.sep) || c.startsWith(p + '/'));
    };

    const blank = () => ({ cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0 });
    const s = { h5: blank(), today: blank(), d7: blank(), d30: blank(), projectToday: blank(), project7d: blank(), projectAll: blank(), last30m: blank() };
    const byDay = new Map();
    const byModel = new Map();
    const byProject = new Map();
    const byHour = new Array(24).fill(0);
    const add = (t, e) => { t.cost += e.cost; t.input += e.input; t.output += e.output; t.cacheRead += e.cacheRead; t.cacheWrite += e.cacheWrite; t.requests++; };

    for (const e of this.entries.values()) {
      const p = inProject(e.cwd);
      if (e.ts >= h5) add(s.h5, e);
      if (e.ts >= today) { add(s.today, e); if (p) add(s.projectToday, e); }
      if (e.ts >= d7) { add(s.d7, e); if (p) add(s.project7d, e); }
      if (e.ts >= now - 30 * 86400000) {
        add(s.d30, e);
        const day = new Date(e.ts); day.setHours(0, 0, 0, 0);
        const k = day.getTime();
        byDay.set(k, (byDay.get(k) || 0) + e.cost);
        if (!byModel.has(e.family)) byModel.set(e.family, blank());
        add(byModel.get(e.family), e);
        const proj = e.cwd ? path.basename(e.cwd) : '(unknown)';
        if (!byProject.has(proj)) byProject.set(proj, { ...blank(), path: e.cwd });
        add(byProject.get(proj), e);
        byHour[new Date(e.ts).getHours()] += e.cost;
      }
      if (p) add(s.projectAll, e);
      if (e.ts >= m30) add(s.last30m, e);
    }
    s.burnPerHour = s.last30m.cost * 2;
    s.byDay = byDay;
    s.byModel = byModel;
    s.byProject = byProject;
    s.byHour = byHour;
    s.lastActivity = this.lastActivity;
    s.hasData = this.entries.size > 0;
    return s;
  }
}

module.exports = { UsageReader };
