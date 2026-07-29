# push-diagrams.ps1
# 把 diagram-technical.mmd 推送到飞书白板（技术流程图）
# 白板 token: DVoqwTA7YhJzvzbq6G9c2AKCn3e
# 所在 wiki: https://jqx28l0j4lx.feishu.cn/wiki/Xia9w7NtPiWoDIkNeg4cwxM1nyb
#
# 用法（在 skill 根目录或任意目录执行均可）:
#   powershell -File "C:\...\qualification-audit\references\push-diagrams.ps1"
#   或在 PS 里: & ".\references\push-diagrams.ps1"

$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$mmdPath   = Join-Path $scriptDir "diagram-technical.mmd"
$wbToken   = "DVoqwTA7YhJzvzbq6G9c2AKCn3e"

if (-not (Test-Path $mmdPath)) {
    Write-Error "找不到源文件: $mmdPath"
    exit 1
}

$lineCount = (Get-Content $mmdPath).Count
Write-Host "源文件行数: $lineCount"

Write-Host "推送到白板 $wbToken ..."

# lark-cli @file 要求相对路径，cd 到 script 目录后用文件名
Push-Location $scriptDir
try {
    $result = lark-cli whiteboard +update `
        --whiteboard-token $wbToken `
        --input_format mermaid `
        --source "@diagram-technical.mmd" `
        --overwrite `
        --as user 2>&1 | ConvertFrom-Json

    if ($result.ok) {
        Write-Host "OK  node_id=$($result.data.node_id ?? '(无返回)')"
    } else {
        Write-Error "FAIL: $($result.error.message)"
    }
} finally {
    Pop-Location
}
