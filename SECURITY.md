# Security Policy

## Supported versions

Only the latest release of Claude Studio by PM receives security fixes.

## Reporting a vulnerability

Please **do not** open a public issue for security problems.

- Use GitHub's private reporting: **Security → Report a vulnerability** on https://github.com/MrPawanMall/claude-studio
- or email **pawan.webmaster@gmail.com** with the subject `Claude Studio security`.

Include the version, your editor (Antigravity / VS Code / Cursor) and steps to reproduce. You'll get a reply within 7 days.

## How Claude Studio protects you

- No telemetry; network access only for features you use (your server, skill sources you add, optional Anthropic plan-usage check).
- Passwords, SSH passphrases and tokens are kept in the editor's secure storage, never in settings or logs.
- SSH host keys are pinned on first use; a changed key blocks the connection. FTPS certificates are verified by default.
- In untrusted workspaces, uploads, PHP checks, live reload and project skill installs are disabled. Executable paths and credential settings are machine-scoped and cannot be set by a project.
- Webviews use a strict Content-Security-Policy (nonce scripts only, no remote code) and only open `https:`, `mailto:` and `tel:` links.
- Skill downloads are https-only, size-limited and checked for path traversal; every skill is previewed before install.
- External programs (php, sound players) are started without a shell, with file paths passed as arguments.
- The live-reload server binds to 127.0.0.1 only and validates the Host header.
