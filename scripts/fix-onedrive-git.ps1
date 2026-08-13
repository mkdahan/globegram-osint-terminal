# Repair Git after OneDrive drops desktop.ini into .git\refs
# (fatal: bad object refs/desktop.ini)
$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path -LiteralPath (Join-Path $root '.git'))) {
    $root = Get-Location
}
$gitDir = Join-Path $root '.git'
if (-not (Test-Path -LiteralPath $gitDir)) {
    Write-Host '[fix-git] No .git folder here. Run this from the project root.'
    exit 1
}

Write-Host '[fix-git] Removing OneDrive desktop.ini files from .git ...'
$junk = Get-ChildItem -LiteralPath $gitDir -Recurse -Force -Filter 'desktop.ini' -ErrorAction SilentlyContinue
foreach ($f in $junk) {
    Write-Host ("  delete " + $f.FullName.Substring($gitDir.Length))
    attrib -s -h -r $f.FullName > $null 2>&1
    Remove-Item -LiteralPath $f.FullName -Force -ErrorAction SilentlyContinue
}

Push-Location $root
try {
    git update-ref -d refs/desktop.ini 2>$null
    git update-ref -d refs/heads/desktop.ini 2>$null
    git update-ref -d refs/remotes/desktop.ini 2>$null
    git gc --prune=now 2>$null | Out-Null
    Write-Host '[fix-git] Fetching origin/master ...'
    git fetch origin master
    if ($LASTEXITCODE -ne 0) {
        Write-Host '[fix-git] Fetch still failed. Move the project OUT of OneDrive and clone again:'
        Write-Host '  git clone https://github.com/mkdahan/globegram-osint-terminal.git'
        exit 1
    }
    git checkout master 2>$null
    git pull --ff-only origin master
    if ($LASTEXITCODE -eq 0) {
        Write-Host '[fix-git] Local files are up to date with GitHub master.'
        git log -1 --oneline
        exit 0
    }
    Write-Host '[fix-git] Fetch worked but pull did not fast-forward. Check git status.'
    git status -sb
    exit 1
} finally {
    Pop-Location
}
