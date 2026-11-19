@echo off
rem `vvpost` do instalador (Windows): o CLI roda no Electron do proprio app em modo Node
rem (ELECTRON_RUN_AS_NODE), sem precisar de Node instalado. Fica em resources\bin.
setlocal
set "ELECTRON_RUN_AS_NODE=1"
"%~dp0..\..\VVPost.exe" "%~dp0..\app.asar\out\main\cli.js" %*
exit /b %errorlevel%
