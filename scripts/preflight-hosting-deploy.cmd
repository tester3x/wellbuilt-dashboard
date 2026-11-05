@echo off
node "%~dp0preflight-hosting-deploy.cjs"
exit /b %errorlevel%
