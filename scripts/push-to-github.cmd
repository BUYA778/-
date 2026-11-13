@echo off
setlocal
rem Wrapper: bypass PowerShell execution policy and call push-to-github.ps1
rem Usage: push-to-github.cmd ^<GitHubToken^> ["commit message"]
if "%~1"=="" (
  echo Usage: %~nx0 ^<GitHubToken^> [commit message]
  exit /b 1
)
set "TOKEN=%~1"
set "MSG=%~2"
if "%MSG%"=="" set "MSG=chore: update mianmian plugin"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0push-to-github.ps1" -Token "%TOKEN%" -Message "%MSG%"
exit /b %ERRORLEVEL%
