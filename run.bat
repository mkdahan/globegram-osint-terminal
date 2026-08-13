@echo off
rem ============================================================
rem  GlobeGram OSINT Terminal launcher
rem  Usage:  run.bat          (normal start)
rem          run.bat demo     (synthetic demo feed, no Telegram)
rem ============================================================
setlocal EnableExtensions
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js not found. Install it from https://nodejs.org and try again.
    pause
    exit /b 1
)

where git >nul 2>nul
if errorlevel 1 goto :after_update
if not exist ".git" goto :after_update
goto :do_update

rem Compare local files vs GitHub master and pull only when remote is newer.
:do_update
rem OneDrive writes desktop.ini into .git\refs → fatal: bad object refs/desktop.ini
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-ChildItem -LiteralPath '.git' -Recurse -Force -Filter 'desktop.ini' -ErrorAction SilentlyContinue | ForEach-Object { attrib -s -h -r $_.FullName >$null 2>&1; Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue }; git update-ref -d refs/desktop.ini 2>$null; git update-ref -d refs/heads/desktop.ini 2>$null" >nul 2>nul

echo [update] Checking GitHub for a newer version...
git fetch origin master
if errorlevel 1 (
    echo [update] Offline or GitHub unreachable — starting with current files.
    goto :after_update
)

git diff --quiet --ignore-submodules HEAD
if errorlevel 1 (
    echo [update] Local files have uncommitted changes — skipping auto-update.
    goto :after_update
)
git diff --quiet --ignore-submodules --cached
if errorlevel 1 (
    echo [update] Local files have staged changes — skipping auto-update.
    goto :after_update
)

for /f "delims=" %%i in ('git rev-parse HEAD') do set LOCAL_SHA=%%i
for /f "delims=" %%i in ('git rev-parse origin/master') do set REMOTE_SHA=%%i
for /f "delims=" %%i in ('git rev-parse --abbrev-ref HEAD') do set CUR_BRANCH=%%i
for /f "delims=" %%i in ('git rev-parse --short HEAD') do set LOCAL_SHORT=%%i
for /f "delims=" %%i in ('git rev-parse --short origin/master') do set REMOTE_SHORT=%%i

if "%LOCAL_SHA%"=="%REMOTE_SHA%" (
    echo [update] Already up to date [%LOCAL_SHORT%].
    goto :after_update
)

rem GitHub master is an ancestor of HEAD → local is the same or newer
git merge-base --is-ancestor origin/master HEAD
if not errorlevel 1 (
    echo [update] Local files are newer than GitHub [%LOCAL_SHORT% vs %REMOTE_SHORT%] — keeping local.
    goto :after_update
)

rem HEAD is an ancestor of GitHub master → remote is strictly newer, safe fast-forward
git merge-base --is-ancestor HEAD origin/master
if errorlevel 1 (
    echo [update] Local and GitHub have diverged — skipping auto-update to avoid overwriting.
    echo [update] To update manually: git checkout master ^&^& git pull --ff-only origin master
    goto :after_update
)

for /f "delims=" %%i in ('git rev-list --count HEAD..origin/master') do set BEHIND=%%i
if /i not "%CUR_BRANCH%"=="master" (
    echo [update] GitHub is newer by %BEHIND% commits [%REMOTE_SHORT%]. Switching to master...
    git checkout master
    if errorlevel 1 (
        echo [update] Could not switch to master — starting with current files.
        goto :after_update
    )
) else (
    echo [update] GitHub is newer by %BEHIND% commits [%REMOTE_SHORT%] — updating local files...
)

git pull --ff-only origin master
if errorlevel 1 (
    echo [update] Could not auto-update — starting with current version.
) else (
    echo [update] Local files are now up to date.
)

:after_update

if not exist "node_modules\electron\dist\electron.exe" goto :npm_install
if not exist "node_modules\axios\" goto :npm_install
if not exist "node_modules\socks-proxy-agent\" goto :npm_install
goto :after_npm

:npm_install
echo [setup] Installing / updating dependencies...
call npm install
if errorlevel 1 (
    echo [ERROR] npm install failed.
    pause
    exit /b 1
)

:after_npm

if /i "%~1"=="demo" (
    set GG_DEMO=1
    echo [demo] Starting with synthetic demo feed...
)

call npm start
if errorlevel 1 pause
endlocal
