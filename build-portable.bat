@echo off
chcp 65001 >nul
echo ==============================================
echo Building zbx-np-node portable (Windows)
echo ==============================================


echo Running build (portable)...
npm run dist
if %ERRORLEVEL% neq 0 (
  echo Build failed with exit code %ERRORLEVEL%.
  exit /b %ERRORLEVEL%
)

echo Build finished. Check the dist\ folder for artifacts.
pause
