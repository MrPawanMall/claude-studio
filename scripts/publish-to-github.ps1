# Claude Studio by PM — create the GitHub repo, push the code and publish the release.
# Run from the claude-studio folder in PowerShell:
#     powershell -ExecutionPolicy Bypass -File scripts\publish-to-github.ps1
# Needs: Git (https://git-scm.com) and GitHub CLI (https://cli.github.com).

$ErrorActionPreference = 'Stop'
$Owner = 'MrPawanMall'
$Repo = 'claude-studio'
$Version = (Get-Content package.json -Raw | ConvertFrom-Json).version
$Vsix = "claude-studio-$Version.vsix"

foreach ($tool in 'git', 'gh') {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
        Write-Host "$tool is not installed. Install it first (git: https://git-scm.com, gh: https://cli.github.com)." -ForegroundColor Red
        exit 1
    }
}

# 1. Sign in to GitHub as MrPawanMall (opens your browser once)
gh auth status 2>$null
if ($LASTEXITCODE -ne 0) { gh auth login --hostname github.com --git-protocol https --web }
$me = gh api user --jq .login
if ($me -ne $Owner) {
    Write-Host "You are signed in to GitHub as '$me', not '$Owner'. Run 'gh auth login' and choose $Owner." -ForegroundColor Yellow
    exit 1
}

# 2. Create the public repo and push the code
gh repo view "$Owner/$Repo" 2>$null
if ($LASTEXITCODE -ne 0) {
    gh repo create "$Owner/$Repo" --public `
        --description "Claude Studio by PM - auto-open, review, undo, SFTP upload, usage & cost, skills and notifications for the Claude agent in Antigravity / VS Code / Cursor." `
        --homepage "https://www.webdevservices.in/" --source . --remote origin --push
} else {
    if (-not (git remote | Select-String -Quiet '^origin$')) { git remote add origin "https://github.com/$Owner/$Repo.git" }
    git push -u origin main
}

gh repo edit "$Owner/$Repo" --add-topic claude --add-topic claude-code --add-topic vscode-extension --add-topic antigravity --add-topic sftp --add-topic ai-agent --enable-discussions --enable-issues

# 3. Tag and create the release with the .vsix
if (-not (Test-Path $Vsix)) { Write-Host "$Vsix not found next to this folder's package.json." -ForegroundColor Red; exit 1 }
git tag -f "v$Version"
git push -f origin "v$Version"
gh release create "v$Version" $Vsix --title "Claude Studio by PM v$Version" --notes-file RELEASE_NOTES.md --latest

Write-Host ""
Write-Host "Done: https://github.com/$Owner/$Repo/releases/tag/v$Version" -ForegroundColor Green
Write-Host "Next: follow PUBLISHING.md to add VSCE_PAT and OVSX_PAT secrets for the Marketplace and Open VSX."
