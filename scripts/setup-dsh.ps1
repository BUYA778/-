param(
  [string]$DshProfileDir = "$env:USERPROFILE\.dsh\profiles\default",
  [string]$OwnerQQ = ""
)

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path "$PSScriptRoot\..").Path

Write-Host "==> [1/4] 检查 Node.js 版本 (需 >= 22.13)..."
$nodeVer = node -v
Write-Host "    当前 Node: $nodeVer"

Write-Host "==> [2/4] 安装依赖并编译 TypeScript..."
Push-Location $RepoRoot
npm install
npm run build
npm test
Pop-Location

Write-Host "==> [3/4] 写入 DSH Profile 插件配置..."
New-Item -ItemType Directory -Force -Path $DshProfileDir | Out-Null
$PluginLink = Join-Path $DshProfileDir "plugins\dsh-plugin-mianmian"
New-Item -ItemType Directory -Force -Path (Split-Path $PluginLink) | Out-Null

if (Test-Path $PluginLink) {
  Remove-Item $PluginLink -Force -Recurse
}
cmd /c mklink /J "`"$PluginLink`"" "`"$RepoRoot`"" | Out-Null

if ($OwnerQQ -ne "") {
  Write-Host "    绑定唯一主人 QQ: $OwnerQQ"
}

Write-Host "==> [4/4] 完成！请重启 DSH 并在设置中确认 mianmian 插件已启用。"
