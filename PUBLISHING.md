# Publishing Claude Studio by PM

Antigravity, Cursor and VSCodium install extensions from **Open VSX**; VS Code installs from the **Visual Studio Marketplace**. Publish to both.

## One-time setup

### 1. Visual Studio Marketplace (VS Code)
1. Sign in at https://marketplace.visualstudio.com/manage with a Microsoft account.
2. **Create publisher** with ID **`pawanmall`** and name **Pawan Mall** (the ID must match `"publisher"` in `package.json`).
3. Create a Personal Access Token in Azure DevOps (https://dev.azure.com → User settings → Personal access tokens):
   - Organization: **All accessible organizations**
   - Scopes: **Custom defined → Marketplace → Manage**
4. In GitHub: **Settings → Secrets and variables → Actions → New repository secret** → name `VSCE_PAT`, value = the token.

### 2. Open VSX (Antigravity, Cursor)
1. Sign in at https://open-vsx.org with your GitHub account (MrPawanMall) and sign the Publisher Agreement in your profile.
2. **Settings → Access Tokens → Generate New Token**.
3. Create the namespace once (replace TOKEN): `npx ovsx create-namespace pawanmall -p TOKEN`
4. In GitHub add a secret named `OVSX_PAT` with the token.

## Every release
1. Update `version` in `package.json` and add an entry to `CHANGELOG.md`.
2. Commit, then tag and push:
   ```
   git tag v2.0.1
   git push origin main --tags
   ```
3. The **Release** workflow tests, packages, creates the GitHub release with the `.vsix`, and publishes to both stores.

## Manual publishing (optional)
```
npm ci --ignore-scripts
npx vsce package
npx vsce publish -p <VSCE_PAT>
npx ovsx publish claude-studio-2.0.0.vsix -p <OVSX_PAT>
```

## Notes for review
- The name uses "Claude", a trademark of Anthropic. The README and About page state the extension is independent and not affiliated with Anthropic. If a store asks for a change, rename `displayName` (e.g. "Studio for Claude by PM").
