@echo off
chcp 65001 >nul
title workBB Installer
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -Command "[Console]::OutputEncoding=[Text.Encoding]::UTF8; $env:PYTHONIOENCODING='utf-8'; & '%~dp0install.ps1' %*"
echo.
echo ------------------------------------------------
echo   (press any key to close)
pause >nul
