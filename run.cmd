@echo off
rem Windows launcher. The logic lives in run.mjs so every platform behaves the same.
setlocal
if defined NODE_BIN (
  "%NODE_BIN%" "%~dp0run.mjs" %*
  exit /b %ERRORLEVEL%
)
where node >nul 2>nul
if errorlevel 1 (
  echo tv-remote-tui: needs Node 26.4 or newer, or NODE_BIN pointing at one
  exit /b 1
)
node "%~dp0run.mjs" %*
exit /b %ERRORLEVEL%
