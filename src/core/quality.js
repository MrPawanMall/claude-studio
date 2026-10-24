'use strict';
// PHP syntax check (php -l) and optional auto-format after Claude edits a file.

const path = require('path');
const { execFile } = require('child_process');
const { vs, cfg } = require('../util');

const PHP_EXT = new Set(['.php', '.phtml', '.inc']);

class Quality {
  constructor(context, log) {
    const vscode = vs();
    this.log = log;
    this.diagnostics = vscode.languages.createDiagnosticCollection('Claude Studio PHP');
    this.warnedMissingPhp = false;
    context.subscriptions.push(
      this.diagnostics,
      vscode.workspace.onDidCloseTextDocument(d => this.diagnostics.delete(d.uri)),
    );
  }

  static isPhp(uri) {
    return PHP_EXT.has(path.extname(uri.fsPath).toLowerCase());
  }

  /**
   * Runs `php -l` on a file. Never uses a shell; the file path is an argv item.
   * @returns {Promise<{ok:boolean, skipped?:boolean, message?:string, line?:number}>}
   */
  lintPhp(uri) {
    const vscode = vs();
    if (!Quality.isPhp(uri) || uri.scheme !== 'file') return Promise.resolve({ ok: true, skipped: true });
    if (!vscode.workspace.isTrusted) return Promise.resolve({ ok: true, skipped: true });
    const phpPath = cfg('php').get('executablePath', '') || 'php';

    return new Promise(resolve => {
      execFile(phpPath, ['-n', '-l', '-d', 'display_errors=1', '-d', 'log_errors=0', uri.fsPath],
        { timeout: 15000, windowsHide: true, maxBuffer: 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err && err.code === 'ENOENT') {
            if (!this.warnedMissingPhp) {
              this.warnedMissingPhp = true;
              vscode.window.showWarningMessage(
                'Claude Studio: PHP wasn\'t found, so the PHP syntax check is skipped. Set the path to php.exe (for example from XAMPP or WAMP).',
                'Set PHP path'
              ).then(p => p && vscode.commands.executeCommand('workbench.action.openSettings', 'claudeStudio.php.executablePath'));
            }
            resolve({ ok: true, skipped: true });
            return;
          }
          const out = `${stdout || ''}\n${stderr || ''}`;
          if (!err && /No syntax errors detected/i.test(out)) {
            this.diagnostics.delete(uri);
            resolve({ ok: true });
            return;
          }
          const m = out.match(/(?:PHP\s+)?(Parse error|Fatal error):\s*(.+?)\s+in\s+.+?\s+on line\s+(\d+)/i);
          if (!m) {
            // unexpected output: don't block the user on our own uncertainty
            this.log(`php -l returned unexpected output for ${uri.fsPath}: ${out.trim().slice(0, 300)}`);
            resolve({ ok: true, skipped: true });
            return;
          }
          const line = Math.max(0, parseInt(m[3], 10) - 1);
          const message = `${m[1]}: ${m[2]}`;
          const d = new vscode.Diagnostic(new vscode.Range(line, 0, line, Number.MAX_SAFE_INTEGER), message, vscode.DiagnosticSeverity.Error);
          d.source = 'Claude Studio (php -l)';
          this.diagnostics.set(uri, [d]);
          resolve({ ok: false, message, line: line + 1 });
        });
    });
  }

  /** Formats a file with the editor's formatter and saves it. */
  async format(uri, tracker) {
    const vscode = vs();
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      if (doc.isDirty) return;
      const edits = await vscode.commands.executeCommand('vscode.executeFormatDocumentProvider', uri,
        { tabSize: 4, insertSpaces: true });
      if (!edits || !edits.length) return;
      const we = new vscode.WorkspaceEdit();
      we.set(uri, edits);
      await vscode.workspace.applyEdit(we);
      await doc.save();
      if (tracker) tracker.snapshot(uri, doc.getText());
    } catch (e) {
      this.log(`Format failed for ${uri.fsPath}: ${e.message}`);
    }
  }
}

module.exports = { Quality };
