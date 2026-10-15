@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"

REM ====================================================================
REM  StonedEditor - Startskript fuer Windows
REM
REM  Verwendung:
REM    start.bat            Prueft alles und startet die Desktop-App
REM                         - ohne Rust wird die Web-Version gestartet
REM    start.bat desktop    Startet die Desktop-App - Tauri
REM    start.bat web        Startet nur die Web-Version auf Port 3000
REM    start.bat help       Zeigt diese Hilfe
REM ====================================================================

set "MODE=%~1"
if "%MODE%"=="" set "MODE=auto"
if /i "%MODE%"=="-h" set "MODE=help"
if /i "%MODE%"=="--help" set "MODE=help"
if /i "%MODE%"=="/?" set "MODE=help"
set "RUST_OK="

title StonedEditor - Start

if /i "%MODE%"=="help" goto :help_page

echo ============================================================
echo   StonedEditor - Systemcheck
echo ============================================================
echo.

REM ---------------- 1. Node.js -------------------------------------
where node >nul 2>nul
if errorlevel 1 (
    echo [FEHLER] Node.js wurde nicht gefunden.
    echo          Bitte Node.js 20 oder neuer installieren: https://nodejs.org/
    goto :fail
)
for /f "delims=" %%v in ('node --version') do set "NODE_VERSION=%%v"
set "NODE_NUM=!NODE_VERSION:v=!"
for /f "tokens=1 delims=." %%a in ("!NODE_NUM!") do set "NODE_MAJOR=%%a"
if not defined NODE_MAJOR goto :node_ok
if !NODE_MAJOR! LSS 20 (
    echo [FEHLER] Node.js !NODE_VERSION! ist zu alt. Benoetigt wird Version 20 oder neuer.
    echo          Download: https://nodejs.org/
    goto :fail
)
:node_ok
echo [OK]     Node.js !NODE_VERSION!

REM ---------------- 2. npm -----------------------------------------
where npm >nul 2>nul
if errorlevel 1 (
    echo [FEHLER] npm wurde nicht gefunden.
    echo          Bitte Node.js erneut installieren: https://nodejs.org/
    goto :fail
)
for /f "delims=" %%v in ('npm --version') do set "NPM_VERSION=%%v"
echo [OK]     npm !NPM_VERSION!

REM ---------------- 3. npm-Abhaengigkeiten -------------------------
set "NEED_INSTALL="
if not exist "node_modules\next\" set "NEED_INSTALL=1"
if not exist "node_modules\react\" set "NEED_INSTALL=1"
if not exist "node_modules\@tauri-apps\cli\" set "NEED_INSTALL=1"

if defined NEED_INSTALL (
    echo [....]   npm-Abhaengigkeiten fehlen oder sind unvollstaendig.
    echo [....]   Installiere Pakete - das kann beim ersten Mal dauern ...
    call npm install --no-fund --no-audit
    if errorlevel 1 (
        echo [FEHLER] "npm install" ist fehlgeschlagen. Bitte Internetverbindung pruefen.
        goto :fail
    )
)
if not exist "node_modules\next\" (
    echo [FEHLER] Die Abhaengigkeiten sind unvollstaendig - "next" fehlt in node_modules.
    goto :fail
)
echo [OK]     npm-Abhaengigkeiten installiert

REM ---------------- 4. Konfiguration .env --------------------------
if exist ".env" (
    echo [OK]     Konfiguration .env gefunden
) else (
    if exist ".env.example" (
        echo [....]   .env fehlt - erstelle sie aus .env.example
        findstr /v /c:"[TEMPLATE]" ".env.example" > ".env"
        echo [OK]     Konfiguration .env erstellt
    ) else (
        echo [WARN]   Keine .env gefunden - es werden die Standardwerte verwendet
    )
)

REM ---------------- 5. Port 3000 freimachen ----------------------
set "PORT_TRIES=0"

:port_check
set "PORT_PID="
for /f "tokens=1,2,3,5" %%a in ('netstat -ano -p tcp') do (
    if /i "%%a"=="TCP" (
        set "P_LOCAL=%%b"
        set "P_REMOTE=%%c"
        set "P_PID=%%d"
        if "!P_LOCAL:~-5!"==":3000" (
            if "!P_REMOTE!"=="0.0.0.0:0" set "PORT_PID=!P_PID!"
            if "!P_REMOTE!"=="[::]:0" if not defined PORT_PID set "PORT_PID=!P_PID!"
        )
    )
)
if not defined PORT_PID goto :port_ok

set "PORT_NAME=unbekannt"
for /f "tokens=1 delims=," %%p in ('tasklist /FI "PID eq !PORT_PID!" /FO CSV /NH 2^>nul') do set "PORT_NAME=%%~p"

if /i not "!PORT_NAME!"=="node.exe" (
    echo [FEHLER] Port 3000 ist von "!PORT_NAME!" belegt ^(PID !PORT_PID!^).
    echo          Bitte dieses Programm beenden und start.bat erneut ausfuehren.
    goto :fail
)

echo [WARN]   Auf Port 3000 laeuft noch ein alter Dev-Server ^(node.exe, PID !PORT_PID!^).
echo [....]   Beende ihn, damit die App starten kann ...
taskkill /F /T /PID !PORT_PID! >nul 2>nul
set /a PORT_TRIES+=1
if !PORT_TRIES! GEQ 10 (
    echo [FEHLER] Port 3000 konnte nicht freigegeben werden.
    goto :fail
)
"%SystemRoot%\System32\timeout.exe" /t 1 /nobreak >nul 2>nul
goto :port_check

:port_ok
echo [OK]     Port 3000 frei

REM ---------------- 6. Rust fuer die Desktop-App -------------------
where cargo >nul 2>nul
if not errorlevel 1 goto :rust_found

REM cargo steckt oft in %USERPROFILE%\.cargo\bin, ohne im PATH zu stehen
if exist "%USERPROFILE%\.cargo\bin\cargo.exe" (
    set "PATH=%USERPROFILE%\.cargo\bin;!PATH!"
    echo [INFO]   Cargo im Standardordner von rustup gefunden - PATH ergaenzt.
)
where cargo >nul 2>nul
if errorlevel 1 goto :no_rust

:rust_found
for /f "delims=" %%v in ('cargo --version') do set "CARGO_VERSION=%%v"
set "RUST_OK=1"
echo [OK]     !CARGO_VERSION!
goto :rust_done

:no_rust
echo [WARN]   Rust/Cargo nicht gefunden - Desktop-App nicht baubar
echo          Fuer die Desktop-App: https://rustup.rs/ installieren
if /i "%MODE%"=="desktop" goto :fail

:rust_done
echo.

REM ---------------- 7. Starten -------------------------------------
if /i "%MODE%"=="web" goto :run_web
if /i "%MODE%"=="desktop" goto :run_desktop
if /i "%MODE%"=="auto" goto :run_auto

echo [FEHLER] Unbekannter Modus "%MODE%". Erlaubt: desktop, web, help
goto :fail

:run_auto
if defined RUST_OK goto :run_desktop
echo [INFO]   Rust fehlt - starte ersatzweise die Web-Version.
goto :run_web

:run_desktop
set "APP_PID="
for /f "tokens=1,2 delims=," %%a in ('tasklist /FI "IMAGENAME eq stoned-editor.exe" /FO CSV /NH 2^>nul') do (
    if /i "%%~a"=="stoned-editor.exe" set "APP_PID=%%~b"
)
if defined APP_PID (
    echo [WARN]   Eine alte StonedEditor-App laeuft noch ^(PID !APP_PID!^) - beende sie.
    taskkill /F /T /PID !APP_PID! >nul 2>nul
    "%SystemRoot%\System32\timeout.exe" /t 1 /nobreak >nul 2>nul
)

echo ============================================================
echo   Starte Desktop-App - Tauri
echo   Es oeffnet sich ein eigenes App-Fenster - kein Browser.
echo   Der erste Build kann mehrere Minuten dauern.
echo ============================================================
echo.
call npm run desktop:dev
goto :end

:run_web
echo ============================================================
echo   Starte Web-Version: http://localhost:3000
echo   Beenden mit Strg+C
echo ============================================================
echo.
call npm run dev
goto :end

REM ---------------- Ende -------------------------------------------
:end
set "EXIT_CODE=%ERRORLEVEL%"
echo.
if not "%EXIT_CODE%"=="0" (
    echo [ENDE]   Die App wurde mit Fehlercode %EXIT_CODE% beendet.
) else (
    echo [ENDE]   Die App wurde beendet.
)
pause
exit /b %EXIT_CODE%

:fail
echo.
echo [ABBRUCH] Bitte die oben genannten Punkte beheben und start.bat erneut ausfuehren.
pause
exit /b 1

:help_page
echo ============================================================
echo   StonedEditor - Startskript
echo ============================================================
echo.
echo   start.bat            Systemcheck, dann Desktop-App
echo                        ohne Rust wird die Web-Version gestartet
echo   start.bat desktop    Desktop-App - eigenes Fenster, ohne Browser
echo   start.bat web        Nur Web-Version auf http://localhost:3000
echo   start.bat help       Diese Hilfe
echo.
pause
exit /b 0
