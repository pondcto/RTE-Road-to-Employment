# ============================================================
# RTE - Build Script (Obfuscation)
#
# Copies extension/ to extension-dist/ and obfuscates all JS
# files with high-protection settings.
#
# Usage: powershell -ExecutionPolicy Bypass -File build.ps1
# ============================================================

$ErrorActionPreference = "Stop"

$srcDir  = Join-Path $PSScriptRoot "extension"
$distDir = Join-Path $PSScriptRoot "extension-dist"

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  RTE Build - Obfuscation Pipeline"       -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# ── Step 1: Clean old dist ──
if (Test-Path $distDir) {
    Write-Host "[1/3] Cleaning old build..." -ForegroundColor Yellow
    Remove-Item -Recurse -Force $distDir
}

# ── Step 2: Copy source to dist ──
Write-Host "[2/3] Copying extension to extension-dist..." -ForegroundColor Yellow
Copy-Item -Recurse -Force $srcDir $distDir
Write-Host "       Copied successfully." -ForegroundColor Green

# ── Step 3: Obfuscate all JS files ──
Write-Host "[3/3] Obfuscating JavaScript files..." -ForegroundColor Yellow
Write-Host ""

$jsFiles = Get-ChildItem -Path $distDir -Filter "*.js" -Recurse

$obfuscatorConfig = @"
{
    "compact": true,
    "controlFlowFlattening": true,
    "controlFlowFlatteningThreshold": 0.75,
    "deadCodeInjection": true,
    "deadCodeInjectionThreshold": 0.4,
    "debugProtection": false,
    "disableConsoleOutput": false,
    "identifierNamesGenerator": "hexadecimal",
    "log": false,
    "numbersToExpressions": true,
    "renameGlobals": false,
    "selfDefending": true,
    "simplify": true,
    "splitStrings": true,
    "splitStringsChunkLength": 10,
    "stringArray": true,
    "stringArrayCallsTransform": true,
    "stringArrayEncoding": ["rc4"],
    "stringArrayIndexShift": true,
    "stringArrayRotate": true,
    "stringArrayShuffle": true,
    "stringArrayWrappersCount": 2,
    "stringArrayWrappersChainedCalls": true,
    "stringArrayWrappersParametersMaxCount": 4,
    "stringArrayWrappersType": "function",
    "stringArrayThreshold": 0.75,
    "transformObjectKeys": true,
    "unicodeEscapeSequence": false
}
"@

# Write config to temp file
$configPath = Join-Path $PSScriptRoot ".obfuscator-config.json"
$obfuscatorConfig | Out-File -Encoding utf8 -FilePath $configPath

$total = $jsFiles.Count
$current = 0

foreach ($file in $jsFiles) {
    $current++
    $relativePath = $file.FullName.Substring($distDir.Length + 1)
    Write-Host "  [$current/$total] $relativePath" -ForegroundColor Gray -NoNewline

    try {
        javascript-obfuscator $file.FullName --output $file.FullName --config $configPath 2>&1 | Out-Null
        Write-Host " -> OK" -ForegroundColor Green
    }
    catch {
        Write-Host " -> FAILED: $_" -ForegroundColor Red
    }
}

# Clean up config
Remove-Item -Force $configPath -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "========================================" -ForegroundColor Green
Write-Host "  Build Complete!" -ForegroundColor Green
Write-Host "  Output: extension-dist/" -ForegroundColor Green
Write-Host "  Load this folder in Chrome." -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
Write-Host ""
