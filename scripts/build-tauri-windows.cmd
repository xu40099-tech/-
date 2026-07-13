@echo off
setlocal

set "ROOT=%~dp0.."
set "VCVARS=%ProgramFiles(x86)%\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"

if not exist "%VCVARS%" (
  echo Visual Studio Build Tools were not found.
  echo Install Microsoft.VisualStudio.2022.BuildTools with the VCTools workload.
  exit /b 1
)

call "%VCVARS%"
cd /d "%ROOT%"
npm run tauri build -- --no-bundle
