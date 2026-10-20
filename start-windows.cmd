@echo off
setlocal
chcp 65001 >nul
where node.exe >nul 2>nul
if errorlevel 1 (
  echo Node.js 22 이상이 필요합니다. https://nodejs.org 에서 현재 사용자용 설치를 확인하세요.
  echo Node.js 설치 후 이 창을 닫고 다시 실행하세요. 관리자 권한과 WSL은 필요하지 않습니다.
  pause
  exit /b 1
)
node.exe -e "process.exit(Number(process.versions.node.split('.')[0]) >= 22 ? 0 : 1)"
if errorlevel 1 (
  echo Node.js 버전이 낮습니다. 22 이상을 설치한 뒤 다시 실행하세요.
  pause
  exit /b 1
)
node.exe "%~dp0scripts\siwc-windows.mjs"
set "SIWC_EXIT=%ERRORLEVEL%"
pause
exit /b %SIWC_EXIT%
