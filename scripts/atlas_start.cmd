@echo off
REM ============================================================
REM A-Atlas｜A股星图 — 启动契约（Refocus 后形态）
REM
REM 1. 校验 Jev 配置（缺失不阻塞启动，Discover 如实 DEGRADED）
REM 2. 启动 stock-data service（a-atlas-data, :8920，唯一常驻 Python 组件）
REM 3. 等待 data health
REM 4. 构建 + 启动 web（:3400, next start）
REM 5. 等待 web health
REM 6. 打开 A-Atlas
REM
REM 本脚本不再启动 Vibe Research（该服务已退役）。Laya 属 a-share-trawler；
REM A-Atlas 的语义判断只有 Jev Cloud 一个来源，失败就降级，不回落。
REM ============================================================
setlocal
set ROOT=%~dp0..
cd /d "%ROOT%"

set ATLAS_DATA_URL=http://127.0.0.1:8920
set ATLAS_DATA_PORT=8920
set PYTHONUTF8=1

echo [1/6] Jev config
REM Key lives in .env.local (gitignored); Next loads it for the server process.
if not exist "%ROOT%\.env.local" (
    echo   WARN: no .env.local - Discover will run DEGRADED with retrieval-only ranking.
) else (
    findstr /B /C:"TYPESAFE_API_KEY=" "%ROOT%\.env.local" | findstr /R /C:"=.." >nul 2>&1
    if errorlevel 1 (
        echo   WARN: TYPESAFE_API_KEY empty - Discover will run DEGRADED ^(semantic judge unavailable^).
        echo   A-Atlas starts anyway; the company page data blocks degrade honestly.
    ) else (
        echo   OK: Jev key configured. Model alias:
        findstr /B /C:"JEV_MODEL=" "%ROOT%\.env.local" 2>nul | findstr /R /C:"=.." >nul 2>&1 && (echo     JEV_MODEL set in .env.local) || (echo     JEV_MODEL unset - defaults to jev-latest)
    )
)

echo [2/6] Stock data service ^(a-atlas-data^)
curl -s -m 3 "%ATLAS_DATA_URL%/health" 2>nul | findstr /C:"a-atlas-data" >nul 2>&1
if errorlevel 1 (
    if not exist "%ROOT%\.local" mkdir "%ROOT%\.local"
    echo   Starting services\stock-data\server.py on %ATLAS_DATA_PORT% ...
    start "a-atlas-data" /b cmd /c "set ATLAS_DATA_PORT=%ATLAS_DATA_PORT%&& set PYTHONUTF8=1&& python -u "%ROOT%\services\stock-data\server.py" > "%ROOT%\.local\data.log" 2>&1"
) else (
    echo   Already healthy - reusing.
)

echo [3/6] Waiting for data health ...
set /a TRIES=0
:wait_data
set /a TRIES+=1
timeout /t 2 /nobreak >nul
curl -s -m 3 "%ATLAS_DATA_URL%/health" 2>nul | findstr /C:"a-atlas-data" >nul 2>&1
if errorlevel 1 (
    if %TRIES% LSS 15 goto wait_data
    echo   WARN: data service did not become healthy. See .local\data.log
    echo   Company page data blocks will show unavailable; web still starts.
    goto web
)
echo   OK.

:web
echo [4/6] Web ^(next build + next start :3400^)
if not exist "%ROOT%\.next" (
    echo   Building ...
    call npm run build || (echo   BUILD FAILED & exit /b 1)
)
start "a-atlas-web" /b cmd /c "set NODE_ENV=production&& set ATLAS_DATA_URL=%ATLAS_DATA_URL%&& npm run start > "%ROOT%\.local\web.log" 2>&1"

echo [5/6] Waiting for web health ...
set /a TRIES=0
:wait_web
set /a TRIES+=1
timeout /t 2 /nobreak >nul
curl -s -m 3 "http://127.0.0.1:3400/api/health" 2>nul | findstr /C:"a-atlas-web" >nul 2>&1
if errorlevel 1 (
    if %TRIES% LSS 30 goto wait_web
    echo   FAIL: web did not become healthy. See .local\web.log
    exit /b 1
)
echo   OK.

echo [6/6] Opening http://127.0.0.1:3400
start "" http://127.0.0.1:3400
echo A-Atlas is up. Data logs: .local\data.log  Web logs: .local\web.log
echo Judge status: http://127.0.0.1:3400/api/health  ^(provider, model, breaker^)
endlocal
