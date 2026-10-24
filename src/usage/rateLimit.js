'use strict';
// Optional: reads your 5-hour / 7-day subscription usage from the
// rate-limit headers of a 1-token request made with your Claude Code login.
// Off until you allow it. The token is read locally, sent only to
// api.anthropic.com, never stored or logged by Claude Studio.
// This relies on undocumented headers and may stop working if they change.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const API_URL = 'https://api.anthropic.com/v1/messages';

function readTokenFromFile(customPath) {
  const p = customPath || path.join(os.homedir(), '.claude', '.credentials.json');
  try {
    const st = fs.statSync(p);
    if (!st.isFile() || st.size > 64 * 1024) return null;
    const creds = JSON.parse(fs.readFileSync(p, 'utf8'));
    return (creds && creds.claudeAiOauth && creds.claudeAiOauth.accessToken) || null;
  } catch {
    return null;
  }
}

function readTokenFromKeychain() {
  if (process.platform !== 'darwin') return Promise.resolve(null);
  return new Promise(resolve => {
    execFile('/usr/bin/security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], { timeout: 5000 }, (err, out) => {
      if (err) return resolve(null);
      try {
        const creds = JSON.parse(String(out).trim());
        resolve((creds && creds.claudeAiOauth && creds.claudeAiOauth.accessToken) || null);
      } catch { resolve(null); }
    });
  });
}

async function getToken(customPath) {
  return readTokenFromFile(customPath) || readTokenFromKeychain();
}

/**
 * @returns {Promise<{util5h:number, util7d:number|null, reset5h:number, reset7d:number|null, status:string}|{error:string}>}
 */
async function fetchRateLimits({ credentialsPath, model }) {
  const token = await getToken(credentialsPath);
  if (!token) return { error: 'No Claude login found. Run "claude" and log in, or set claudeStudio.usage.credentialsPath.' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'oauth-2025-04-20',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: model || 'claude-haiku-5-5', max_tokens: 1, messages: [{ role: 'user', content: '.' }] }),
    });
    const h = name => res.headers.get(`anthropic-ratelimit-unified-${name}`);
    const u5 = h('5h-utilization');
    if (u5 === null) {
      return { error: res.ok ? 'Usage limits are not reported for this account type.' : `Usage check failed (HTTP ${res.status}).` };
    }
    const nowSec = Date.now() / 1000;
    const r5 = parseInt(h('5h-reset') || '0', 10);
    const r7raw = h('7d-reset');
    const u7 = h('7d-utilization');
    return {
      util5h: parseFloat(u5) || 0,
      util7d: u7 === null ? null : (parseFloat(u7) || 0),
      reset5h: r5 ? Math.max(0, r5 - nowSec) : 0,
      reset7d: r7raw ? Math.max(0, parseInt(r7raw, 10) - nowSec) : null,
      status: h('5h-status') || '',
      time: Date.now(),
    };
  } catch (e) {
    return { error: e.name === 'AbortError' ? 'Usage check timed out.' : 'Usage check failed (network).' };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { fetchRateLimits };
