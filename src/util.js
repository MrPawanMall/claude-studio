'use strict';
// Shared helpers for Claude Studio by PM.

const path = require('path');
const crypto = require('crypto');

const NS = 'claudeStudio';

let vscode;
function vs() {
  // lazy so pure helpers can be unit-tested without the editor
  if (!vscode) vscode = require('vscode');
  return vscode;
}

function cfg(section) {
  return vs().workspace.getConfiguration(section ? `${NS}.${section}` : NS);
}

/** Case-insensitive key on Windows (d:\server\www\...) */
function fileKey(fsPath) {
  return process.platform === 'win32' ? fsPath.toLowerCase() : fsPath;
}

function toPosix(p) {
  return p.replace(/\\/g, '/');
}

// ---------- glob matching (supports **, *, ?, {a,b}) ----------
const globCache = new Map();
function globToRegExp(glob) {
  const cached = globCache.get(glob);
  if (cached) return cached;
  let re = '';
  let inBraces = false;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') { i++; re += '(?:.*/)?'; } else { re += '.*'; }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if (c === '{') {
      inBraces = true; re += '(?:';
    } else if (c === '}' && inBraces) {
      inBraces = false; re += ')';
    } else if (c === ',' && inBraces) {
      re += '|';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  const rx = new RegExp('^' + re + '$', 'i');
  globCache.set(glob, rx);
  return rx;
}

/** relPath must be posix and relative. Also tests against the absolute path. */
function matchesAny(globs, relPath, absPath) {
  const rel = toPosix(relPath);
  const abs = absPath ? toPosix(absPath) : '';
  return (globs || []).some(g => {
    if (!g || typeof g !== 'string') return false;
    const rx = globToRegExp(g);
    return rx.test(rel) || rx.test('/' + rel) || (abs && rx.test(abs));
  });
}

/**
 * sftp.json style ignore: a bare name (".git", "node_modules") matches any path
 * segment; anything with a slash or wildcard is treated as a glob.
 */
function matchesIgnore(entries, relPath) {
  const rel = toPosix(relPath).replace(/^\/+/, '');
  const segments = rel.split('/');
  return (entries || []).some(e => {
    if (!e || typeof e !== 'string') return false;
    const entry = toPosix(e).replace(/^\.\//, '');
    if (!/[*?/{]/.test(entry)) return segments.some(s => s.toLowerCase() === entry.toLowerCase());
    const g = entry.startsWith('/') ? entry.slice(1) : entry;
    const rx = globToRegExp(g.endsWith('/') ? g + '**' : g);
    return rx.test(rel) || globToRegExp('**/' + g).test(rel) || globToRegExp(g + '/**').test(rel);
  });
}

// ---------- line diff ----------
const MAX_LCS_CELLS = 4_000_000;

/**
 * Compares two texts line by line.
 * Returns { lines: 0-based changed/added line numbers in newText, added, removed }.
 */
function diffLines(oldText, newText) {
  const a = oldText.split(/\r?\n/);
  const b = newText.split(/\r?\n/);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length - 1, endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) { endA--; endB--; }

  const midA = a.slice(start, endA + 1);
  const midB = b.slice(start, endB + 1);

  if (midA.length === 0 && midB.length === 0) return { lines: [], added: 0, removed: 0 };
  if (midB.length === 0) {
    return { lines: [Math.max(0, Math.min(start, b.length - 1))], added: 0, removed: midA.length };
  }
  if (midA.length === 0) {
    return { lines: midB.map((_, i) => start + i), added: midB.length, removed: 0 };
  }
  if (midA.length * midB.length > MAX_LCS_CELLS) {
    return { lines: midB.map((_, i) => start + i), added: midB.length, removed: midA.length };
  }

  const n = midA.length, m = midB.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = midA[i] === midB[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const lines = [];
  let i = 0, j = 0, removed = 0;
  while (i < n || j < m) {
    if (i < n && j < m && midA[i] === midB[j]) { i++; j++; }
    else if (j >= m || (i < n && dp[i + 1][j] >= dp[i][j + 1])) { i++; removed++; }
    else { lines.push(start + j); j++; }
  }
  const added = lines.length;
  if (!lines.length) lines.push(Math.max(0, Math.min(start, b.length - 1)));
  return { lines, added, removed };
}

// ---------- security helpers ----------
function nonce() {
  return crypto.randomBytes(16).toString('base64');
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** True when `child` (after resolving) is inside `parent`. Works for posix remote paths too. */
function isInside(parent, child, posix = false) {
  const p = posix ? path.posix : path;
  const rel = p.relative(p.resolve(parent), p.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !p.isAbsolute(rel));
}

/** Validates a relative path from an untrusted archive/repo (zip-slip guard). */
function safeRelative(rel) {
  if (typeof rel !== 'string' || !rel) return null;
  const norm = path.posix.normalize(toPosix(rel)).replace(/^\.\/+/, '');
  if (norm.startsWith('/') || /^[a-zA-Z]:/.test(norm) || norm.split('/').includes('..') || norm.includes('\0')) return null;
  return norm;
}

function isHttpsUrl(u) {
  try { return new URL(u).protocol === 'https:'; } catch { return false; }
}

function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
}

// ---------- formatting ----------
function money(n) {
  return '$' + (n || 0).toFixed(2);
}

function compact(n) {
  n = n || 0;
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(Math.round(n));
}

function duration(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}

function timeAgo(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function clock(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

module.exports = {
  NS, vs, cfg, fileKey, toPosix, globToRegExp, matchesAny, matchesIgnore, diffLines,
  nonce, escapeHtml, isInside, safeRelative, isHttpsUrl, slug, money, compact, duration, timeAgo, clock,
  _clearGlobCache: () => globCache.clear(),
};
