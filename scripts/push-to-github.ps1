#requires -Version 5.1
<#
.SYNOPSIS
    通过 GitHub REST API 把本地目录内容提交到指定仓库分支（本机无需安装 git）。

.DESCRIPTION
    执行流程：
      1. 校验 Token 身份与仓库写权限（permissions.push）
      2. 逐个文件调用 Git Blobs API 创建 blob
      3. 以远端分支最新 commit 的 tree 作为 base_tree 构建新 tree
         （只新增/覆盖本次提交的文件，不会删除远端已有的其它文件）
      4. 创建 commit，并快进更新分支引用
      5. 回读远端 tree 做一次文件数校验

.PARAMETER Token
    GitHub Personal Access Token。
      经典 Token：需要 repo 权限
      细粒度 Token：需要目标仓库的 Contents: Read and write

.PARAMETER Message
    提交信息（支持中文，脚本按 UTF-8 发送）。

.EXAMPLE
    .\push-to-github.ps1 -Token $env:GITHUB_TOKEN -Message "feat: 眠眠 2.0.0 首次入库"

.EXAMPLE
    # 只列出将要上传的文件，不实际提交
    .\push-to-github.ps1 -Token $env:GITHUB_TOKEN -DryRun
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Token,

    [string]$Owner = 'BUYA778',
    [string]$Repo = '-',
    [string]$Branch = 'main',

    # 留空则取脚本所在目录的上一级（即仓库根目录）
    [string]$SourceDir = '',

    [string]$Message = 'chore: update mianmian plugin',

    [string]$AuthorName = '',
    [string]$AuthorEmail = '',

    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch { }

if (-not $SourceDir) {
    if ($PSScriptRoot) { $SourceDir = Split-Path -Parent $PSScriptRoot }
    else { $SourceDir = (Get-Location).Path }
}

$ApiBase = "https://api.github.com/repos/$Owner/$Repo"
$Headers = @{
    Authorization          = "Bearer $Token"
    Accept                 = 'application/vnd.github+json'
    'User-Agent'           = 'mianmian-repo-uploader'
    'X-GitHub-Api-Version' = '2022-11-28'
}

# ---------------------------------------------------------------- HTTP 封装
function Invoke-GH {
    param(
        [Parameter(Mandatory = $true)][string]$Method,
        [Parameter(Mandatory = $true)][string]$Path,
        $Body = $null
    )
    $uri = if ($Path -match '^https?://') { $Path } else { $ApiBase + $Path }
    $params = @{
        Method      = $Method
        Uri         = $uri
        Headers     = $Headers
        ErrorAction = 'Stop'
    }
    if ($null -ne $Body) {
        $json = $Body | ConvertTo-Json -Depth 20 -Compress
        $params.Body = [System.Text.Encoding]::UTF8.GetBytes($json)
        $params.ContentType = 'application/json; charset=utf-8'
    }
    try {
        Invoke-RestMethod @params
    }
    catch {
        $detail = ''
        try {
            $resp = $_.Exception.Response
            if ($resp) {
                $stream = $resp.GetResponseStream()
                if ($stream) {
                    $reader = New-Object System.IO.StreamReader($stream, [System.Text.Encoding]::UTF8)
                    $detail = $reader.ReadToEnd()
                    $reader.Dispose()
                }
            }
        }
        catch { }
        $msg = "GitHub API 调用失败 [$Method $uri]`n  " + $_.Exception.Message + "`n  " + $detail
        throw $msg.Trim()
    }
}

# ---------------------------------------------------------------- 1. 身份与权限
if (-not $DryRun) {
    Write-Host '==> 校验 Token' -ForegroundColor Cyan
    $me = Invoke-GH -Method GET -Path 'https://api.github.com/user'
    Write-Host ("    身份: {0} ({1})" -f $me.login, $me.id)

    # 注意：仓库名是 "-"，带尾斜杠的 /repos/BUYA778/-/ 会返回 404，必须用无尾斜杠的完整 URL
    $repoInfo = Invoke-GH -Method GET -Path $ApiBase
    Write-Host ("    仓库: {0}  私有={1}  默认分支={2}" -f $repoInfo.full_name, $repoInfo.private, $repoInfo.default_branch)
    if ($repoInfo.permissions -and -not $repoInfo.permissions.push) {
        throw "当前 Token 对该仓库没有写权限（permissions.push = false）。请重新生成带 Contents: Read and write 的 Token。"
    }
}

# ---------------------------------------------------------------- 2. 收集文件
$excludeDirs = @('.git', 'node_modules', 'dist', 'build', '.next', '.cache', '__pycache__')
$excludeNames = @('.DS_Store', 'Thumbs.db', 'desktop.ini')

$root = (Resolve-Path -LiteralPath $SourceDir).Path.TrimEnd('\', '/')
if (-not (Test-Path -LiteralPath $root)) { throw "源目录不存在: $SourceDir" }

$files = @()
foreach ($f in Get-ChildItem -LiteralPath $root -Recurse -File -Force) {
    $rel = $f.FullName.Substring($root.Length).TrimStart('\', '/') -replace '\\', '/'
    $parts = $rel -split '/'
    $skip = $false
    foreach ($p in $parts) { if ($excludeDirs -contains $p) { $skip = $true } }
    if ($excludeNames -contains $f.Name) { $skip = $true }
    if ($rel -like '*.tsbuildinfo') { $skip = $true }
    if (-not $skip) {
        $files += [pscustomobject]@{ Path = $rel; Full = $f.FullName; Size = $f.Length }
    }
}

$totalKb = 0
if ($files.Count -gt 0) { $totalKb = (($files | Measure-Object -Property Size -Sum).Sum / 1KB) }
Write-Host ("==> 待上传文件 {0} 个，合计 {1:N1} KB" -f $files.Count, $totalKb) -ForegroundColor Cyan
foreach ($f in $files) {
    Write-Host ("    {0,10:N0}  {1}" -f $f.Size, $f.Path)
}

if ($DryRun) {
    Write-Host '==> DryRun 模式，未向 GitHub 提交任何内容。' -ForegroundColor Yellow
    return
}

# ---------------------------------------------------------------- 3. 建 blob
Write-Host '==> 创建 blob' -ForegroundColor Cyan
$treeItems = @()
$i = 0
foreach ($f in $files) {
    $i++
    $bytes = [System.IO.File]::ReadAllBytes($f.Full)
    $b64 = [System.Convert]::ToBase64String($bytes)
    $blob = Invoke-GH -Method POST -Path '/git/blobs' -Body @{ content = $b64; encoding = 'base64' }
    $treeItems += @{ path = $f.Path; mode = '100644'; type = 'blob'; sha = $blob.sha }
    Write-Host ("    [{0}/{1}] {2}" -f $i, $files.Count, $f.Path)
}

# ---------------------------------------------------------------- 4. 基线 commit
Write-Host '==> 读取分支基线' -ForegroundColor Cyan
$baseCommitSha = $null
$baseTreeSha = $null
try {
    $ref = Invoke-GH -Method GET -Path "/git/ref/heads/$Branch"
    $baseCommitSha = $ref.object.sha
    $baseCommit = Invoke-GH -Method GET -Path "/git/commits/$baseCommitSha"
    $baseTreeSha = $baseCommit.tree.sha
    Write-Host ("    基线 commit: {0}" -f $baseCommitSha.Substring(0, 12))
}
catch {
    Write-Host ("    分支 {0} 不存在或为空仓库，将创建首个 commit" -f $Branch) -ForegroundColor Yellow
}

# ---------------------------------------------------------------- 5. 建 tree + commit
Write-Host '==> 创建 tree' -ForegroundColor Cyan
$treeBody = @{ tree = $treeItems }
if ($baseTreeSha) { $treeBody.base_tree = $baseTreeSha }
$newTree = Invoke-GH -Method POST -Path '/git/trees' -Body $treeBody

Write-Host '==> 创建 commit' -ForegroundColor Cyan
$commitBody = @{
    message = $Message
    tree    = $newTree.sha
    parents = @()
}
if ($baseCommitSha) { $commitBody.parents = @($baseCommitSha) }
if ($AuthorName) {
    $commitBody.author = @{ name = $AuthorName; email = $AuthorEmail }
    $commitBody.committer = @{ name = $AuthorName; email = $AuthorEmail }
}
$commit = Invoke-GH -Method POST -Path '/git/commits' -Body $commitBody
Write-Host ("    commit: {0}" -f $commit.sha)

# ---------------------------------------------------------------- 6. 更新分支
Write-Host '==> 更新分支引用' -ForegroundColor Cyan
if ($baseCommitSha) {
    $null = Invoke-GH -Method PATCH -Path "/git/refs/heads/$Branch" -Body @{ sha = $commit.sha; force = $false }
}
else {
    $null = Invoke-GH -Method POST -Path '/git/refs' -Body @{ ref = "refs/heads/$Branch"; sha = $commit.sha }
}

# ---------------------------------------------------------------- 7. 校验
Write-Host '==> 回读远端 tree 校验' -ForegroundColor Cyan
$remoteTree = Invoke-GH -Method GET -Path "/git/trees/$Branch`?recursive=1"
$remoteBlobs = @($remoteTree.tree | Where-Object { $_.type -eq 'blob' })
Write-Host ("    远端文件数: {0}   本地提交文件数: {1}" -f $remoteBlobs.Count, $files.Count)

$missing = @()
foreach ($f in $files) {
    $hit = $remoteBlobs | Where-Object { $_.path -eq $f.Path }
    if (-not $hit) { $missing += $f.Path }
}
if ($missing.Count -gt 0) {
    Write-Warning ("以下文件未在远端找到: {0}" -f ($missing -join ', '))
}
else {
    Write-Host '    全部文件已确认存在。' -ForegroundColor Green
}

Write-Host ''
Write-Host ("完成: https://github.com/{0}/{1}/commit/{2}" -f $Owner, $Repo, $commit.sha) -ForegroundColor Green
Write-Host ("浏览: https://github.com/{0}/{1}/tree/{2}" -f $Owner, $Repo, $Branch) -ForegroundColor Green
