@echo off
title Print Scanning Service

echo ============================================
echo   Print Scanning Service (port 4545)
echo ============================================
echo.

:: Check if Node.js is installed, auto-install via winget if missing
where node >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo [WARN] Node.js is not installed. Attempting to install it automatically...
    echo.

    where winget >nul 2>&1
    if %ERRORLEVEL% NEQ 0 (
        echo [ERROR] winget is not available, cannot auto-install.
        echo.
        echo Please download and install Node.js from:
        echo   https://nodejs.org
        echo.
        echo Recommended version: Node.js 18 LTS or higher.
        pause
        exit /b 1
    )

    echo [INFO] Installing latest Node.js LTS via winget...
    winget install OpenJS.NodeJS.LTS -e --silent --accept-package-agreements --accept-source-agreements

    :: PATH may not refresh in this session; fall back to the default install location
    set "PATH=%PATH%;%ProgramFiles%\nodejs"

    where node >nul 2>&1
    if %ERRORLEVEL% NEQ 0 (
        echo [ERROR] Node.js installation failed or requires a new terminal session.
        echo Close this window, open a new Command Prompt, and run start.bat again.
        pause
        exit /b 1
    )

    echo.
    echo [OK] Node.js installed successfully.
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
