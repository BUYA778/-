# Windows + DSH 本地部署指南

## 前置要求
1. **Windows 10 / 11**
2. **Node.js ≥ 22.13**（利用内置 `node:sqlite` 与 `node:test`，无需编译 C++ 原生依赖）
3. **DeepSeek Harness (DSH)**
4. **SnowLuma2**（自行安装并扫码登录 QQ 小号/机器人号，开启 OneBot v11 WebSocket）

## 安装步骤
1. 解压或克隆本仓库到本地目录（例如 `D:\mianmian`）
2. 打开 PowerShell 执行：
   ```powershell
   .\scripts\setup-dsh.ps1 -OwnerQQ "你的QQ号"
   ```
3. 在 `~/.dsh/profiles/<你的profile>/cordis.patch.yml` 中填入：
   - `ownerQQ`: 你的个人 QQ 号（只有你发的消息会被处理）
   - `snowluma.wsUrl` / `token`: SnowLuma2 的本地 WebSocket 地址与令牌
   - `voice`: 若需要在线语音，设置 `enabled: true` 并填写 `onlineEndpoint` 与 `apiKey`
4. 重启 DSH，即可开始 1v1 私聊。
