@echo off
rem NongFon: double-click to install, set up and start (Windows)
chcp 65001 >nul
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install\nongfon.ps1" menu
pause
