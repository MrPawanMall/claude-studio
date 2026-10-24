'use strict';
// Skill sources: GitHub repositories, direct URLs (.zip or SKILL.md) and local
// folders. Everything downloaded is size-capped and path-checked.

const fs = require('fs');
const path = require('path');
const { safeRelative, isHttpsUrl, toPosix } = require('../util');

const LIMITS = { maxFiles: 300, maxFileBytes: 10 * 1024 * 1024, maxTotalBytes: 30 * 1024 * 1024, maxZipBytes: 30 * 1024 * 1024 };
const RISKY_EXT = new Set(['.sh', '.bash', '.zsh', '.ps1', '.psm1', '.bat', '.cmd', '.exe', '.dll', '.so', '.dylib', '.py', '.js', '.mjs', '.cjs', '.ts', '.rb', '.pl', '.php', '.jar', '.vbs', '.scr', '.msi', '.com']);

function parseFrontmatter(text) {
  const out = {};
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text || '');
  if (!m) return out;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    let v = kv[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[kv[1]] = v;
  }
  return out;
}

function isRisky(rel) {
  return RISKY_EXT.has(path.extname(rel).toLowerCase());
}

async function httpGet(url, { token, json = false, maxBytes = LIMITS.maxZipBytes, accept } = {}) {
  if (!isHttpsUrl(url)) throw new Error('Only https:// links are allowed');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    const headers = { 'User-Agent': 'claude-studio-by-pm' };
    if (accept) headers.Accept = accept;
    // only ever send the GitHub token to GitHub
    const host = new URL(url).hostname;
    if (token && (host === 'api.github.com' || host === 'raw.githubusercontent.com')) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(url, { headers, signal: ctrl.signal, redirect: 'follow' });
    if (!isHttpsUrl(res.url || url)) throw new Error('Redirected to a non-https address');
    if (res.status === 403 && host === 'api.github.com') throw new Error('GitHub rate limit reached. Add a GitHub token with "Claude Studio: Set GitHub Token for Skills", or try again later.');
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    const len = Number(res.headers.get('content-length') || 0);
    if (len && len > maxBytes) throw new Error(`File is too large (${Math.round(len / 1048576)} MB)`);
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) { ctrl.abort(); throw new Error('Download is too large'); }
      chunks.push(value);
    }
    const buf = Buffer.concat(chunks.map(c => Buffer.from(c)));
    return json ? JSON.parse(buf.toString('utf8')) : buf;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('Download timed out or was too large');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** Accepts "owner/repo", "https://github.com/owner/repo", ".../tree/branch/sub/path". */
function parseGithub(input) {
  const s = String(input || '').trim().replace(/\.git$/, '');
  let m = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(s);
  if (m) return { repo: `${m[1]}/${m[2]}` };
  m = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:\/tree\/([^/]+)(?:\/(.+))?)?\/?$/.exec(s);
  if (m) return { repo: `${m[1]}/${m[2]}`, branch: m[3], path: m[4] ? decodeURIComponent(m[4]) : undefined };
  return null;
}

/**
 * A skill found in a source.
 * @typedef {{ id:string, dir:string, name:string, description:string, files:{rel:string,size:number}[], version?:string, source:object, readFile:(rel:string)=>Promise<Buffer> }} SkillRef
 */

// ---------------- GitHub ----------------
async function listGithub(source, token, onProgress) {
  const enc = p => p.split('/').map(encodeURIComponent).join('/');
  const info = await httpGet(`https://api.github.com/repos/${source.repo}`, { token, json: true, accept: 'application/vnd.github+json' });
  const branch = source.branch || info.default_branch || 'main';
  const tree = await httpGet(`https://api.github.com/repos/${source.repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
    { token, json: true, accept: 'application/vnd.github+json', maxBytes: 50 * 1024 * 1024 });
  const prefix = source.path ? toPosix(source.path).replace(/^\/+|\/+$/g, '') + '/' : '';
  const entries = (tree.tree || []).filter(e => !prefix || e.path === prefix.slice(0, -1) || e.path.startsWith(prefix));
  const dirs = entries.filter(e => e.type === 'blob' && (e.path === 'SKILL.md' || e.path.endsWith('/SKILL.md')))
    .map(e => (e.path === 'SKILL.md' ? '' : e.path.slice(0, -'/SKILL.md'.length)))
    .filter(d => !/(^|\/)template$/.test(d));
  const treeSha = new Map(entries.filter(e => e.type === 'tree').map(e => [e.path, e.sha]));
  const raw = rel => `https://raw.githubusercontent.com/${source.repo}/${enc(branch)}/${enc(rel)}`;

  const skills = dirs.slice(0, 200).map(dir => {
    const base = dir ? dir + '/' : '';
    const files = entries.filter(e => e.type === 'blob' && e.path.startsWith(base))
      .filter(e => !dirs.some(other => other !== dir && other.startsWith(base) && e.path.startsWith(other + '/')))
      .map(e => ({ rel: e.path.slice(base.length), size: e.size || 0 }));
    return {
      id: `gh:${source.repo}:${dir}`,
      dir,
      name: path.posix.basename(dir) || source.repo.split('/')[1],
      description: '',
      files,
      version: treeSha.get(dir) || tree.sha,
      source: { ...source, branch },
      readFile: rel => httpGet(raw(base + rel), { token, maxBytes: LIMITS.maxFileBytes }),
    };
  });

  // fetch SKILL.md headers for names/descriptions (limited concurrency)
  let done = 0;
  const queue = skills.slice();
  const workers = Array.from({ length: 8 }, async () => {
    while (queue.length) {
      const s = queue.shift();
      try {
        const fm = parseFrontmatter((await s.readFile('SKILL.md')).toString('utf8'));
        if (fm.name) s.name = fm.name;
        s.description = fm.description || '';
      } catch { /* keep folder name */ }
      onProgress && onProgress(++done, skills.length);
    }
  });
  await Promise.all(workers);
  return skills;
}

// ---------------- ZIP / URL ----------------
async function listUrl(source, token) {
  const gh = parseGithub(source.url);
  if (gh) return listGithub({ ...source, type: 'github', ...gh }, token);

  if (/\/SKILL\.md(\?.*)?$/i.test(source.url)) {
    const text = (await httpGet(source.url, { maxBytes: LIMITS.maxFileBytes })).toString('utf8');
    const fm = parseFrontmatter(text);
    return [{
      id: `url:${source.url}`, dir: '', name: fm.name || 'skill', description: fm.description || '',
      files: [{ rel: 'SKILL.md', size: Buffer.byteLength(text) }], source,
      readFile: async rel => { if (rel !== 'SKILL.md') throw new Error('not found'); return Buffer.from(text, 'utf8'); },
    }];
  }

  const zipBuf = await httpGet(source.url, { maxBytes: LIMITS.maxZipBytes });
  return listZipBuffer(zipBuf, source);
}

function listZipBuffer(zipBuf, source) {
  const { unzipSync } = require('fflate');
  let total = 0;
  let count = 0;
  const files = unzipSync(new Uint8Array(zipBuf), {
    filter: f => {
      count++;
      total += f.originalSize;
      if (count > 2000 || total > LIMITS.maxTotalBytes * 2) throw new Error('Archive is too large');
      return f.originalSize <= LIMITS.maxFileBytes && !f.name.endsWith('/');
    },
  });
  const safe = new Map();
  for (const [name, data] of Object.entries(files)) {
    const rel = safeRelative(name);
    if (!rel || rel.startsWith('__MACOSX/')) continue; // zip-slip & junk guard
    safe.set(rel, Buffer.from(data));
  }
  const dirs = [...safe.keys()].filter(p => p === 'SKILL.md' || p.endsWith('/SKILL.md'))
    .map(p => (p === 'SKILL.md' ? '' : p.slice(0, -'/SKILL.md'.length)));
  return dirs.map(dir => {
    const base = dir ? dir + '/' : '';
    const own = [...safe.keys()].filter(p => p.startsWith(base) && !dirs.some(o => o !== dir && o.startsWith(base) && p.startsWith(o + '/')));
    const fm = parseFrontmatter(safe.get(base + 'SKILL.md').toString('utf8'));
    return {
      id: `zip:${source.url || source.name}:${dir}`, dir,
      name: fm.name || path.posix.basename(dir) || 'skill',
      description: fm.description || '',
      files: own.map(p => ({ rel: p.slice(base.length), size: safe.get(p).length })),
      source,
      readFile: async rel => {
        const b = safe.get(base + rel);
        if (!b) throw new Error('not found');
        return b;
      },
    };
  });
}

// ---------------- local folder ----------------
async function listFolder(source) {
  const root = source.folder;
  const found = [];
  const walk = (d, depth) => {
    if (depth > 5 || found.length > 200) return;
    let names;
    try { names = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    if (names.some(n => n.isFile() && n.name === 'SKILL.md')) found.push(d);
    for (const n of names) if (n.isDirectory() && !n.name.startsWith('.') && n.name !== 'node_modules') walk(path.join(d, n.name), depth + 1);
  };
  walk(root, 0);
  return found.map(dir => {
    const files = [];
    const collect = (d, depth) => {
      if (depth > 8 || files.length > LIMITS.maxFiles) return;
      for (const n of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, n.name);
        if (n.isSymbolicLink()) continue;
        if (n.isDirectory()) { if (!found.includes(p)) collect(p, depth + 1); }
        else if (n.isFile()) files.push({ rel: toPosix(path.relative(dir, p)), size: fs.statSync(p).size });
      }
    };
    collect(dir, 0);
    const fm = parseFrontmatter(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8'));
    return {
      id: `dir:${dir}`, dir: toPosix(path.relative(root, dir)),
      name: fm.name || path.basename(dir), description: fm.description || '',
      files, source,
      readFile: async rel => {
        const safe = safeRelative(rel);
        if (!safe) throw new Error('bad path');
        return fs.readFileSync(path.join(dir, safe));
      },
    };
  });
}

async function listSource(source, token, onProgress) {
  if (source.type === 'github') return listGithub(source, token, onProgress);
  if (source.type === 'url') return listUrl(source, token);
  if (source.type === 'folder') return listFolder(source);
  throw new Error(`Unknown source type: ${source.type}`);
}

module.exports = { listSource, listZipBuffer, parseFrontmatter, parseGithub, isRisky, httpGet, LIMITS };
