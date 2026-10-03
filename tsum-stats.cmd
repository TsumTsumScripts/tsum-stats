@echo off
rem Tsum Tsum Stats for Windows: double-click this file.
rem
rem The first time, it downloads the program from
rem https://github.com/TsumTsumScripts/tsum-stats/releases/latest, checks its
rem sha256 against the release's own pin, and keeps it in
rem %LOCALAPPDATA%\TsumTsumStats\program. After that it just starts it. The
rem program opens in your browser and updates itself; close this window (or
rem press Ctrl+C) to stop it.
title Tsum Tsum Stats
set "TS_DIR=%LOCALAPPDATA%\TsumTsumStats\program"
if exist "%TS_DIR%\tsum-stats.exe" goto run

echo Downloading Tsum Tsum Stats ...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; try { [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; $b='https://github.com/TsumTsumScripts/tsum-stats/releases/latest/download'; $w=New-Object Net.WebClient; $pin=$w.DownloadString($b+'/tsum-stats.txt'); $want=[regex]::Match($pin,'(?m)^sha256_windows_amd64=(\w+)').Groups[1].Value; New-Item -ItemType Directory -Force $env:TS_DIR | Out-Null; $f=Join-Path $env:TS_DIR 'tsum-stats.exe'; $w.DownloadFile($b+'/tsum-stats-windows-amd64.exe', $f+'.part'); if ((Get-FileHash ($f+'.part') -Algorithm SHA256).Hash -ne $want) { Remove-Item ($f+'.part'); throw 'The download did not match its checksum, so it was deleted.' }; Move-Item -Force ($f+'.part') $f } catch { Write-Host ('Could not install: ' + $_.Exception.Message); exit 1 }"
if errorlevel 1 (
  echo.
  echo Check your internet connection and try again.
  pause
  exit /b 1
)

:run
"%TS_DIR%\tsum-stats.exe"
if errorlevel 1 pause
