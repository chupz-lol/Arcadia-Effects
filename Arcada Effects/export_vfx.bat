@echo off
rem Экспорт эффектов из Arcadia-Effects прямо в игру Flutter
chcp 65001 >nul
cd /d "%~dp0"
echo Сборка эффектов и экспорт в assets/images/vfx/...
node tools/export_vfx_to_game.mjs
echo.
pause
