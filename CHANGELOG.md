# Changelog

## 2.0.2 — 2026-10-29

- Extension ID is now `pawanmall.claude-studio-by-pm` in every store (the name `claude-studio` was already taken on the VS Code Marketplace). The display name is still **Claude Studio by PM**.
- Published on the VS Code Marketplace.

## 2.0.1 — 2026-10-29

- Published on Open VSX (Antigravity, Cursor, VSCodium).
- Extension homepage, README and About page now link to the extension page on webdevservices.in.
- New banner image in the README.

## 2.0.0 — 2026-10-24

Renamed from **Claude Auto Open** to **Claude Studio by PM** and rebuilt as an all-in-one companion for the Claude agent.

### Added
- **Changes panel**: every file Claude edits, grouped by task, with +/− line counts and a review badge.
- **Show diff**, **undo one file**, **undo whole task**, and **checkpoints** with revert.
- Change markers that stay until a file is reviewed; tab limit; close tabs Claude opened; pause for 10/30/60 minutes; per-project on/off.
- **PHP syntax check** after each Claude edit (Problems panel); optional auto-format.
- **Built-in SFTP / FTP / FTPS upload** reading `.vscode/sftp.json`: auto-upload Claude's edits, upload on save, production confirmation, PHP error gate, secure password storage, SSH host-key verification, upload history and retry, download, compare with server, profile switching.
- **Usage & cost**: status bar, hover breakdown, dashboard (30-day chart, by hour, by model, by project), budget alerts, optional 5h/7d plan usage.
- **Skills manager**: personal and project skills; browse/install from GitHub, links, folders and .zip files; preview with script warnings; create; enable/disable; delete; update check.
- **Notification system** with history panel, unread badge, Do Not Disturb, and per-event sounds (6 built-in or your own file).
- **Live reload** for your local site.
- **About & credits** page.
- Workspace Trust support, strict webview CSP, `sftp.json` schema validation.

## 1.0.0 — 2026-10-24
- First version (Claude Auto Open): open files the Claude agent edits and highlight the changes.
