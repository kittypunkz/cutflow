@echo off
setlocal EnableExtensions

cd /d "%~dp0"
title CutFlow Setup and Start

echo.
echo ==============================
echo  CutFlow setup and start
echo ==============================
echo.

set "PYTHON_CMD="

where py >nul 2>nul
if not errorlevel 1 (
    py -3 -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)" >nul 2>nul
    if not errorlevel 1 set "PYTHON_CMD=py -3"
)

if not defined PYTHON_CMD (
    where python >nul 2>nul
    if not errorlevel 1 (
        python -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)" >nul 2>nul
        if not errorlevel 1 set "PYTHON_CMD=python"
    )
)

if not defined PYTHON_CMD (
    echo Python 3.10 or newer was not found.
    echo.
    where winget >nul 2>nul
    if not errorlevel 1 (
        echo This setup can install Python with Windows Package Manager.
        choice /C YN /M "Install Python now"
        if errorlevel 2 goto python_missing
        winget install --id Python.Python.3.12 -e
        echo.
        echo Python installation finished. Please close this window, then run setup_and_start.bat again.
        pause
        exit /b 0
    )
    goto python_missing
)

echo Found Python:
%PYTHON_CMD% --version
echo.

if not exist ".venv\Scripts\python.exe" (
    echo Creating local Python environment...
    %PYTHON_CMD% -m venv .venv
    if errorlevel 1 goto venv_failed
) else (
    echo Found existing local Python environment.
)

echo.
echo Updating Python package installer...
".venv\Scripts\python.exe" -m pip install --upgrade pip
if errorlevel 1 goto pip_failed

echo.
echo Installing or updating app dependencies...
".venv\Scripts\python.exe" -m pip install -r requirements.txt
if errorlevel 1 goto pip_failed

echo.
call :find_ffmpeg
if not defined FFMPEG_READY (
    echo FFmpeg and FFprobe were not found.
    echo They are required for video cutting and compression.
    echo.
    where winget >nul 2>nul
    if not errorlevel 1 (
        echo This setup can install FFmpeg with Windows Package Manager.
        choice /C YN /M "Install FFmpeg now"
        if errorlevel 2 goto ffmpeg_missing
        winget install --id Gyan.FFmpeg -e
        echo.
        echo Checking FFmpeg again...
        call :find_ffmpeg
        if not defined FFMPEG_READY (
            echo FFmpeg was installed, but this window cannot see it yet.
            echo Please close this window, open setup_and_start.bat again, and try once more.
            pause
            exit /b 0
        )
    ) else (
        goto ffmpeg_missing
    )
)

echo Found FFmpeg.
echo.
echo Starting CutFlow at http://localhost:5000 ...
start "" http://localhost:5000
".venv\Scripts\python.exe" app.py
goto end

:find_ffmpeg
set "FFMPEG_READY="
where ffmpeg >nul 2>nul
if errorlevel 1 goto check_winget_ffmpeg
where ffprobe >nul 2>nul
if errorlevel 1 goto check_winget_ffmpeg
set "FFMPEG_READY=1"
exit /b 0

:check_winget_ffmpeg
for /d %%D in ("%LOCALAPPDATA%\Microsoft\WinGet\Packages\Gyan.FFmpeg*") do (
    for /d %%B in ("%%~fD\*\bin") do (
        if exist "%%~fB\ffmpeg.exe" if exist "%%~fB\ffprobe.exe" (
            set "PATH=%%~fB;%PATH%"
            set "FFMPEG_READY=1"
            exit /b 0
        )
    )
)
exit /b 0

:python_missing
echo Please install Python 3.10 or newer from:
echo https://www.python.org/downloads/
echo.
echo During installation, select "Add python.exe to PATH".
pause
exit /b 1

:venv_failed
echo Failed to create the local Python environment.
pause
exit /b 1

:pip_failed
echo Failed to install Python dependencies.
echo Check your internet connection, then run this file again.
pause
exit /b 1

:ffmpeg_missing
echo Please install FFmpeg, then run this file again.
echo Recommended command:
echo winget install Gyan.FFmpeg
pause
exit /b 1

:end
echo.
echo CutFlow stopped.
pause
