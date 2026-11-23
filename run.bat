@echo off
REM Serves the game locally (ES modules do not load from file://) and opens it.
cd /d "%~dp0"
REM Browsers cannot list folders: refresh the lists of recordings in assets\barks, assets\ambient, assets\birds.
python tools\make_manifests.py
start "" http://localhost:8000/
python tools\serve.py 8000
