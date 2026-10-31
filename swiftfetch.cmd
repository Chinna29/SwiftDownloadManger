@echo off
rem Launch SwiftFetch from the source checkout without the dev server.
rem Requires "npm install" and "npm run build:renderer" to have been run once.
setlocal
set "ROOT=%~dp0"
if not exist "%ROOT%dist\index.html" (
  echo Renderer not built yet. Running vite build...
  call "%ROOT%node_modules\.bin\vite.cmd" build || exit /b 1
)
start "" "%ROOT%node_modules\electron\dist\electron.exe" "%ROOT%." %*
endlocal
