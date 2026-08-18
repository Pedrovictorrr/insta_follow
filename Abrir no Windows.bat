@echo off
rem Duplo-clique neste arquivo para abrir o ig-lists.
cd /d "%~dp0"

where py >nul 2>&1
if %errorlevel%==0 (
  py server.py
  goto :eof
)

where python >nul 2>&1
if %errorlevel%==0 (
  python server.py
  goto :eof
)

echo O ig-lists precisa do Python 3.
echo Instale na Microsoft Store (procure por "Python") ou em python.org/downloads
echo e abra este arquivo de novo.
start "" "https://www.python.org/downloads/"
pause
