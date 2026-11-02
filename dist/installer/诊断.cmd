@echo off
chcp 65001 >nul
title workBB Diagnose
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -Command "[Console]::OutputEncoding=[Text.Encoding]::UTF8; & '%~dp0diagnose.ps1' %*"
