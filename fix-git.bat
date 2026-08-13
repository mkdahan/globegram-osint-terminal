@echo off
rem Repair a Git repo that OneDrive corrupted with desktop.ini inside .git\
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\fix-onedrive-git.ps1"
if errorlevel 1 pause
exit /b %ERRORLEVEL%
