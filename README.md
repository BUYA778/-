# 眠眠 2.0（Mianmian）— 面向 Windows + DSH 的省 Token 1v1 私聊伴侣插件

融合 **`surfcore` 1v1 精简版** 与 **`dsh-world` 核心设计**：
- **仅 1v1 QQ 私聊**：入口硬锁唯一 `ownerQQ`，彻底移除群聊、桌宠、B站与本地语音包。
- **三层省钱记忆**：`我是谁.md` + 固定 11 词 `mood.md` + `叙事衰减记忆卡` + `SQLite 全量归档/只读历史日记/相册` + `memory_find/read` 按需翻旧账。
- **省 Token 80% 核心设计**：
  1. 从 39+ 工具缩减为 **6 个大脑决策型工具**（`memory_find` / `memory_read` / `set_mood` / `plan_next` / `write_diary` / `save_photo`），日常私聊 **1 轮直出**；
  2. **前静后动 Prompt 排布**（工具与人设放最前吃 1 折 Prefix Cache，实时时间与心情放尾部）；
  3. 剥离工具调用的 **`toolFree` 对话压缩**，将单次上下文控制在低水位；
  4. **错峰低谷整理**：凌晨自动执行叙事卡衰减与整理。
- **纯在线语音**：仅留云端 TTS HTTP 接口，带 120 字与每分钟 2 条频控。

---

## 仓库结构

```text
├── src/                 插件源码（TypeScript）
│   ├── index.ts         插件入口与运行时装配
│   ├── config.ts        配置解析 / YAML 生成 / 模型档位表
│   ├── context/         前静后动 Prompt 排布与上下文压缩
│   ├── dsh/             DSH 模型自动发现（含思考档位推断）
│   ├── life/            心情、相册、主动关怀、闹钟
│   ├── memory/          叙事卡、日记、归档、自我笔记
│   ├── persona/         角色卡加载
│   ├── qq/              SnowLuma OneBot v11 私聊通道
│   └── voice/           在线 TTS
├── tests/               node:test 单元测试
├── scripts/             本地部署与仓库维护脚本
│   ├── setup-dsh.ps1        生成 DSH profile 的 cordis.patch.yml
│   ├── start-mianmian.bat   一键启动入口
│   └── push-to-github.ps1   无需 git 的仓库同步脚本（见下）
├── release/             各版本打包产物（zip 归档）
├── cordis.patch.yml     DSH 装配补丁模板
├── INSTALL.md           Windows + DSH 部署指南
└── package.json / tsconfig.json
```

## 安装

详见 [INSTALL.md](INSTALL.md)。

## 维护：把本地改动同步到本仓库

本机没装 git 也能用。仓库自带 `scripts/push-to-github.ps1`，直接走 GitHub REST API（Git Data API）提交：

```powershell
# 1) 先看会传哪些文件（不发写请求）
.\scripts\push-to-github.ps1 -Token $env:GITHUB_TOKEN -DryRun

# 2) 正式提交
.\scripts\push-to-github.ps1 -Token $env:GITHUB_TOKEN -Message "feat: 眠眠 2.0.1"
```

若提示「未对文件进行数字签名」，用包装脚本绕过执行策略：

```bat
scripts\push-to-github.cmd <你的Token> "feat: 眠眠 2.0.1"
```

### 需要的 Token 权限

| Token 类型 | 需要的权限 | 生成入口 |
| --- | --- | --- |
| Classic（经典） | `repo`（整仓读写） | <https://github.com/settings/tokens/new?scopes=repo> |
| Fine-grained（细粒度，推荐） | 仅本仓库 `Contents: Read and write`，另需 `Metadata: Read-only`（GitHub 强制附带） | <https://github.com/settings/personal-access-tokens/new> |

脚本会先调用 `GET /repos/BUYA778/-` 检查 `permissions.push`，权限不足会直接报错退出，不会产生半截提交。

### 或者用 git（装了 git 之后）

```powershell
git clone https://github.com/BUYA778/-.git mianmian
cd mianmian
# ...改动...
git add -A
git commit -m "feat: 眠眠 2.0.1"
git push origin main
```

## 版本

- `2.0.0` — 首个入库版本，见 `release/mianmian-plugin-v2.0.0.zip`

## License

MIT
