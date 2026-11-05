@echo off
node "%~dp0deploy-hosting.cjs" --verify
exit /b %errorlevel%
