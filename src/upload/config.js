'use strict';
// Reads `.vscode/sftp.json` (same format as the popular SFTP extension, so an
// existing setup keeps working) and works out which server a file belongs to.

const path = require('path');
const jsonc = require('jsonc-parser');
const { toPosix, isInside, matchesIgnore, fileKey } = require('../util');

const DEFAULT_IGNORE = ['.vscode', '.git', '.DS_Store', 'node_modules', '.claude'];
const CONFIG_REL = path.join('.vscode', 'sftp.json');

/**
 * Parses sftp.json text. Returns a list of raw config objects.
 * @param {string} text
 */
function parseConfigText(text) {
  const errors = [];
  const data = jsonc.parse(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length && data === undefined) throw new Error('sftp.json is not valid JSON');
  if (Array.isArray(data)) return data.filter(x => x && typeof x === 'object');
  if (data && typeof data === 'object') return [data];
  return [];
}

/**
 * Applies a profile and normalises a raw config.
 * @param {object} raw
 * @param {string} folderPath  workspace folder (absolute)
 * @param {string|undefined} profileName
 */
function resolveConfig(raw, folderPath, profileName, index = 0) {
  const profiles = raw.profiles && typeof raw.profiles === 'object' ? raw.profiles : {};
  const profile = profileName && profiles[profileName] ? profileName : (raw.defaultProfile && profiles[raw.defaultProfile] ? raw.defaultProfile : undefined);
  const merged = { ...raw, ...(profile ? profiles[profile] : {}) };
  delete merged.profiles;

  const protocol = String(merged.protocol || 'sftp').toLowerCase() === 'ftp' ? 'ftp' : 'sftp';
  const context = merged.context ? String(merged.context) : '';
  const localRoot = path.resolve(folderPath, context);
  if (!isInside(folderPath, localRoot)) throw new Error(`"context" in sftp.json points outside the project: ${context}`);

  let remotePath = toPosix(String(merged.remotePath || '/'));
  if (!remotePath.startsWith('/')) remotePath = '/' + remotePath;
  remotePath = path.posix.normalize(remotePath);

  if (!merged.host || typeof merged.host !== 'string') throw new Error('sftp.json is missing "host"');

  const port = Number(merged.port) || (protocol === 'sftp' ? 22 : 21);
  return {
    id: `${fileKey(folderPath)}#${index}`,
    name: merged.name || merged.host,
    folderPath,
    localRoot,
    protocol,
    secure: protocol === 'ftp' ? (merged.secure === true || merged.secure === 'implicit' ? merged.secure : false) : undefined,
    host: merged.host,
    port,
    username: merged.username || '',
    password: typeof merged.password === 'string' ? merged.password : undefined,
    privateKeyPath: typeof merged.privateKeyPath === 'string' ? merged.privateKeyPath : undefined,
    passphrase: merged.passphrase,
    agent: typeof merged.agent === 'string' ? merged.agent : undefined,
    remotePath,
    uploadOnSave: merged.uploadOnSave === true,
    ignore: Array.isArray(merged.ignore) ? merged.ignore : DEFAULT_IGNORE,
    connectTimeout: Number(merged.connectTimeout) || 15000,
    profile,
    profiles: Object.keys(profiles),
    index,
    secretKey: `${protocol}://${merged.username || ''}@${merged.host}:${port}`,
  };
}

/**
 * Remote path for a local file, or null when the file is outside the mapped
 * folder or ignored. Guarded so nothing can escape `remotePath`.
 */
function remotePathFor(config, localPath) {
  if (!isInside(config.localRoot, localPath)) return null;
  const rel = toPosix(path.relative(config.localRoot, localPath));
  if (!rel || matchesIgnore(config.ignore, rel)) return null;
  const remote = path.posix.join(config.remotePath, rel);
  if (!isInside(config.remotePath, remote, true)) return null;
  return remote;
}

/** Picks the config whose local root contains the file (longest match wins). */
function configForFile(configs, localPath) {
  let best = null;
  for (const c of configs) {
    if (isInside(c.localRoot, localPath) && (!best || c.localRoot.length > best.localRoot.length)) best = c;
  }
  return best;
}

/** Removes "password" from sftp.json text (all configs and profiles), keeping comments and formatting. */
function stripPasswords(text) {
  const root = jsonc.parseTree(text);
  if (!root) return text;
  const edits = [];
  const visit = node => {
    if (!node) return;
    if (node.type === 'property' && node.children && node.children[0].value === 'password') {
      edits.push(jsonc.getNodePath(node.children[0]));
    }
    (node.children || []).forEach(visit);
  };
  visit(root);
  let out = text;
  // remove deepest/last first so offsets stay valid
  for (const p of edits.reverse()) {
    const e = jsonc.modify(out, p, undefined, { formattingOptions: { insertSpaces: true, tabSize: 4 } });
    out = jsonc.applyEdits(out, e);
  }
  return out;
}

const TEMPLATE = `{
    // Claude Studio by PM — server upload settings (same format as the SFTP extension).
    // Your password is NOT stored here: Claude Studio asks once and keeps it in the
    // editor's secure storage.
    "name": "My Server",
    "protocol": "sftp",          // "sftp" or "ftp"
    "host": "example.com",
    "port": 22,
    "username": "username",
    "remotePath": "/public_html",
    "uploadOnSave": true,
    "ignore": [".vscode", ".git", ".claude", "node_modules", "writable/cache", "writable/logs"],
    "profiles": {
        "dev":  { "remotePath": "/staging" },
        "prod": { "remotePath": "/public_html" }
    },
    "defaultProfile": "dev"
}
`;

module.exports = { parseConfigText, resolveConfig, remotePathFor, configForFile, stripPasswords, CONFIG_REL, TEMPLATE, DEFAULT_IGNORE };
