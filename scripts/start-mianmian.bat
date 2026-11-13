@echo off
chcp 65001 >nul
title 眠眠 2.0 - Windows 启动器
cd /d "%~dp0\.."

echo [1/2] 检查编译产物...
if not exist "dist\index.js" (
  echo 未检测到 dist\index.js，正在执行首次编译...
  call npm run build
)

echo [2/2] 运行离线单元测试校验...
call npm test
if errorlevel 1 (
  echo 自检失败，请先排查报错后重试。
  pause
  exit /b 1
)

echo 一切就绪！请打开 DSH 桌面端即可启用「眠眠 2.0」1v1 私聊伴侣插件。
pause
