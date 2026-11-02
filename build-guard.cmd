@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

where dotnet >nul 2>nul
if errorlevel 1 (
  echo dotnet SDK not found. Install from https://dotnet.microsoft.com/download
  exit /b 1
)

dotnet build "src-cs\guard.csproj" -c Release -o "dist\bin" --nologo -v q
if errorlevel 1 (
  echo build failed
  exit /b 1
)

echo.
echo   OK - dist\bin\workbb-guard.exe
echo.
echo   dist\bin\workbb-guard.exe install
echo   dist\bin\workbb-guard.exe status
echo   dist\bin\workbb-guard.exe uninstall
echo.
endlocal
