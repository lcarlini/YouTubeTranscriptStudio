@echo off
setlocal EnableExtensions
title YouTube Transcript Studio
set "DEST=%LOCALAPPDATA%\YouTubeTranscriptStudio\extension"
set "ZIP=%TEMP%\youtube-transcript-studio-extension.zip"
set "URL=https://lcarlini.github.io/YouTubeTranscriptStudio/extension.zip"

echo Downloading the Chrome extension...
curl.exe -fL --retry 3 -o "%ZIP%" "%URL%"
if errorlevel 1 goto fail

if not exist "%DEST%" mkdir "%DEST%"
tar -xf "%ZIP%" -C "%DEST%"
if not exist "%DEST%\manifest.json" goto fail

powershell -NoProfile -Command "Set-Clipboard -Value '%DEST%'"

set "CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" set "CHROME=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" set "CHROME=%LocalAppData%\Google\Chrome\Application\chrome.exe"
if exist "%CHROME%" (
  start "" "%CHROME%" "chrome://extensions/"
) else (
  echo Chrome was not found. Open chrome://extensions/ yourself.
)

powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; [void][System.Windows.Forms.MessageBox]::Show('The extension folder is ready and its path is copied.'+[Environment]::NewLine+[Environment]::NewLine+'In the Chrome tab that just opened:'+[Environment]::NewLine+'1. Turn on Developer mode'+[Environment]::NewLine+'2. Click Load unpacked'+[Environment]::NewLine+'3. Paste the folder path into the address bar and press Enter'+[Environment]::NewLine+[Environment]::NewLine+'%DEST%','YouTube Transcript Studio')"
exit /b 0

:fail
echo The extension could not be downloaded. Check your connection and try again.
pause
exit /b 1
