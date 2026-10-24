'use strict';
// One reusable connection per server (SFTP via ssh2, FTP/FTPS via basic-ftp).
// Connections close themselves after a short idle period.

const fs = require('fs');
const os = require('os');
const path = require('path');

const IDLE_MS = 60000;

function expandHome(p) {
  return p && p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

class Connection {
  /**
   * @param {object} config   resolved config from config.js
   * @param {object} auth     { password?, privateKey?, passphrase? }
   * @param {object} opts     { hostVerifier(host, port, fingerprint): Promise<boolean>, allowSelfSigned }
   */
  constructor(config, auth, opts) {
    this.config = config;
    this.auth = auth;
    this.opts = opts;
    this.client = null;
    this.connecting = null;
    this.idleTimer = undefined;
    this.chain = Promise.resolve();
  }

  async connect() {
    if (this.client) return this.client;
    if (this.connecting) return this.connecting;
    this.connecting = this.config.protocol === 'ftp' ? this.connectFtp() : this.connectSftp();
    try {
      this.client = await this.connecting;
      return this.client;
    } finally {
      this.connecting = null;
    }
  }

  async connectSftp() {
    const SftpClient = require('ssh2-sftp-client');
    const c = this.config;
    const client = new SftpClient('claude-studio');
    const options = {
      host: c.host, port: c.port, username: c.username,
      readyTimeout: c.connectTimeout,
      keepaliveInterval: 20000,
      hostVerifier: (key, verify) => {
        const fp = 'SHA256:' + require('crypto').createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
        this.opts.hostVerifier(c.host, c.port, fp).then(ok => verify(!!ok), () => verify(false));
      },
    };
    if (this.auth.privateKey) {
      options.privateKey = this.auth.privateKey;
      if (this.auth.passphrase) options.passphrase = this.auth.passphrase;
    }
    if (this.auth.password) options.password = this.auth.password;
    if (c.agent) options.agent = c.agent;
    await client.connect(options);
    client.on && client.on('error', () => { this.client = null; });
    return client;
  }

  async connectFtp() {
    const ftp = require('basic-ftp');
    const c = this.config;
    const client = new ftp.Client(c.connectTimeout);
    client.ftp.verbose = false;
    await client.access({
      host: c.host, port: c.port, user: c.username, password: this.auth.password || '',
      secure: c.secure || false,
      secureOptions: c.secure ? { rejectUnauthorized: !this.opts.allowSelfSigned, servername: c.host } : undefined,
    });
    return client;
  }

  /** Runs operations one after another on this connection. */
  run(fn) {
    const next = this.chain.then(async () => {
      clearTimeout(this.idleTimer);
      try {
        const client = await this.connect();
        return await fn(client);
      } catch (e) {
        // drop a broken connection so the next call reconnects
        await this.close();
        throw e;
      } finally {
        clearTimeout(this.idleTimer);
        this.idleTimer = setTimeout(() => this.close(), IDLE_MS);
      }
    });
    this.chain = next.catch(() => {});
    return next;
  }

  upload(localPath, remotePath) {
    return this.run(async client => {
      const dir = path.posix.dirname(remotePath);
      if (this.config.protocol === 'ftp') {
        await client.ensureDir(dir);
        await client.cd('/');
        await client.uploadFrom(localPath, remotePath);
      } else {
        const exists = await client.exists(dir);
        if (!exists) await client.mkdir(dir, true);
        await client.put(localPath, remotePath);
      }
    });
  }

  download(remotePath, localPath) {
    return this.run(async client => {
      if (this.config.protocol === 'ftp') await client.downloadTo(localPath, remotePath);
      else await client.get(remotePath, localPath);
    });
  }

  async close() {
    clearTimeout(this.idleTimer);
    const c = this.client;
    this.client = null;
    if (!c) return;
    try {
      if (this.config.protocol === 'ftp') c.close();
      else await c.end();
    } catch { /* ignore */ }
  }
}

function readPrivateKey(p) {
  const full = expandHome(p);
  const st = fs.statSync(full);
  if (!st.isFile() || st.size > 64 * 1024) throw new Error('privateKeyPath does not point to a private key file');
  return fs.readFileSync(full);
}

module.exports = { Connection, readPrivateKey, expandHome };
