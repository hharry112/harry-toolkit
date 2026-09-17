# 將插件輸出到指定資料夾
# 用法：
#   .\deploy.ps1                       # 使用上次記住的路徑
#   .\deploy.ps1 -VaultPath "c:\TEMP"  # 指定路徑並記住
#
# 若目標路徑是 Obsidian vault（含 .obsidian），會放到 .obsidian\plugins\harry-toolkit；
# 否則直接輸出到 <路徑>\harry-toolkit，可整個資料夾複製到另一台電腦的
# <vault>\.obsidian\plugins\ 底下。
param(
    [string]$VaultPath = ""
)

$root = $PSScriptRoot
$configFile = Join-Path $root "deploy.config.json"

if (-not $VaultPath) {
    if (Test-Path $configFile) {
        $VaultPath = (Get-Content $configFile -Raw | ConvertFrom-Json).vaultPath
    }
    if (-not $VaultPath) {
        Write-Host "第一次執行請指定路徑：.\deploy.ps1 -VaultPath `"c:\TEMP`"" -ForegroundColor Yellow
        exit 1
    }
}

# 記住路徑供下次使用
@{ vaultPath = $VaultPath } | ConvertTo-Json | Out-File $configFile -Encoding utf8

if (Test-Path (Join-Path $VaultPath ".obsidian")) {
    $dest = Join-Path $VaultPath ".obsidian\plugins\harry-toolkit"
} else {
    $dest = Join-Path $VaultPath "harry-toolkit"
}
New-Item -ItemType Directory -Force $dest | Out-Null

foreach ($f in @("main.js", "manifest.json", "styles.css")) {
    $src = Join-Path $root $f
    if (-not (Test-Path $src)) {
        Write-Host "缺少 $f，請先執行建置：.\.node\node.exe esbuild.config.mjs production" -ForegroundColor Red
        exit 1
    }
    Copy-Item $src $dest -Force
}

Write-Host "已輸出到 $dest" -ForegroundColor Green
Write-Host "若是輸出到中繼資料夾，請將 harry-toolkit 整個資料夾複製到另一台電腦的 <vault>\.obsidian\plugins\ 底下，"
Write-Host "再到 Obsidian「設定 → 社群插件」啟用（已啟用者按 Ctrl+R 重新載入）。"
