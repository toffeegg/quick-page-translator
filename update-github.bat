@echo off
setlocal enabledelayedexpansion

cd /d "%~dp0"

echo ==========================================
echo   Quick Page Translator GitHub Updater
echo ==========================================
echo.

git rev-parse --is-inside-work-tree >nul 2>&1
if errorlevel 1 (
  echo This folder is not a Git repository.
  echo Run your initial GitHub setup first, then try again.
  echo.
  pause
  exit /b 1
)

git remote get-url origin >nul 2>&1
if errorlevel 1 (
  echo No Git remote named origin was found.
  echo Add your GitHub remote first, then try again.
  echo.
  pause
  exit /b 1
)

echo Press any key to stage, commit, and push this project to GitHub.
pause >nul

echo.
echo Checking for changes...
git status --short

git diff --quiet
set "has_working_changes=%errorlevel%"
git diff --cached --quiet
set "has_staged_changes=%errorlevel%"

if "%has_working_changes%"=="0" if "%has_staged_changes%"=="0" (
  echo.
  echo No changes to push.
  echo.
  pause
  exit /b 0
)

echo.
echo Staging files...
git add .
if errorlevel 1 (
  echo Failed to stage files.
  echo.
  pause
  exit /b 1
)

for /f %%I in ('powershell -NoProfile -Command "Get-Date -Format ''yyyy-MM-dd HH:mm:ss''"') do set "commit_time=%%I"
set "commit_message=Update project %commit_time%"

echo.
echo Creating commit...
git commit -m "%commit_message%"
if errorlevel 1 (
  echo Commit failed. You may need to resolve an issue or set your Git identity.
  echo.
  pause
  exit /b 1
)

echo.
echo Pushing to GitHub...
git push
if errorlevel 1 (
  echo Push failed. Check your GitHub authentication or remote branch setup.
  echo.
  pause
  exit /b 1
)

echo.
echo Update complete.
echo.
pause
