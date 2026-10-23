@echo off
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "%~dp0start-watchdog.ps1" 1>>"%~dp0startup-task-stdout.log" 2>>"%~dp0startup-task-stderr.log"
