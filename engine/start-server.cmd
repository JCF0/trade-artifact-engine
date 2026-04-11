@echo off
cd /d "%~dp0"
node src/api/server.mjs --port 3000
