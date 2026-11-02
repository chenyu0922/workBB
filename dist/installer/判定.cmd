@echo off
chcp 65001 >nul
title workBB Judge
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -Command "[Console]::OutputEncoding=[Text.Encoding]::UTF8; & '%~dp0judge.ps1' %*"
