@echo off
title Print Scanning Service

echo ============================================
echo   Print Scanning Service (port 4545)
echo ============================================
echo.

:: Check if Node.js is installed
where node >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Node.js is not installed.
    echo.
    echo Please download and install Node.js from:
    echo   https://nodejs.org
    echo.
    echo Recommended version: Node.js 18 LTS or higher.
    pause
    exit /b 1
)

:: Display Node.js version for debugging
for /f "tokens=*" %%i in ('node --version') do set NODE_VERSION=%%i
echo [OK] Node.js found: %NODE_VERSION%

:: Check if npm is available
where npm >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] npm is not available. Reinstall Node.js from https://nodejs.org
    pause
    exit /b 1
)

echo [OK] npm found.
echo.

:: Install dependencies if node_modules is missing
if not exist "node_modules\" (
    echo [INFO] Installing dependencies...
    echo.
    npm install
    if %ERRORLEVEL% NEQ 0 (
        echo [ERROR] npm install failed. Check your internet connection and try again.
        pause
        exit /b 1
    )
    echo.
    echo [OK] Dependencies installed.
    echo.
)

:: Start the scanning service
echo [INFO] Starting scanning service on port 4545...
echo [INFO] Press Ctrl+C to stop.
echo.
node index.js

pause
