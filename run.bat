@echo off
rem ============================================================
rem  GlobeGram OSINT Terminal launcher
rem  Usage:  run.bat          (normal start)
rem          run.bat demo     (synthetic demo feed, no Telegram)
rem ============================================================
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js not found. Install it from https://nodejs.org and try again.
    pause
    exit /b 1
)

rem Auto-update: grab the latest version from GitHub (skipped quietly if offline)
where git >nul 2>nul
if not errorlevel 1 (
    if exist ".git" (
        echo [update] Checking GitHub for updates...
        git pull --ff-only origin master
        if errorlevel 1 echo [update] Could not auto-update - starting with current version.
    )
)

if not exist "node_modules\electron\dist\electron.exe" (
    echo [setup] Installing dependencies - one time only...
    call npm install
    if errorlevel 1 (
        echo [ERROR] npm install failed.
        pause
        exit /b 1
    )
)

if /i "%~1"=="demo" (
    set GG_DEMO=1
    echo [demo] Starting with synthetic demo feed...
)

call npm start
if errorlevel 1 pause
endlocal
