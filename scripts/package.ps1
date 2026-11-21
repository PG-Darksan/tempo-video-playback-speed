# 配布フォルダーと ZIP を作る
#   powershell -ExecutionPolicy Bypass -File scripts/package.ps1
#
# 作るもの（dist/ 以下）
#   Tempo/                    直下に manifest.json がある拡張機能フォルダー（「パッケージ化されていない拡張機能を読み込む」用）
#   Tempo-Chrome-Edge.zip     Tempo フォルダーを格納した配布用 ZIP
#   Tempo-webstore.zip        Chrome ウェブストア / Edge アドオンへのアップロード用（ZIP 直下に manifest.json）
#
# 開発依存（node_modules）、テスト、動画 fixture、scripts は含めない。

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$dist = Join-Path $root 'dist'
$folderName = 'Tempo'
$folder = Join-Path $dist $folderName
$zipPath = Join-Path $dist 'Tempo-Chrome-Edge.zip'
$storeZipPath = Join-Path $dist 'Tempo-webstore.zip'

$files = @(
  'manifest.json',
  'background.js',
  'content.js',
  'shared.js',
  'i18n.js',
  'popup.html',
  'popup.css',
  'popup.js',
  'README.md'
)
$directories = @('_locales', 'icons')
$locales = @('ja', 'en', 'ko', 'zh_CN', 'zh_TW', 'es', 'fr', 'de', 'pt_BR', 'ru', 'hi', 'ar')
$icons = @('icon16.png', 'icon32.png', 'icon48.png', 'icon128.png')

# 1. 翻訳カタログの整合チェック（Node.js がある場合）
$node = Get-Command node -ErrorAction SilentlyContinue
if ($node) {
  & $node.Source (Join-Path $root 'scripts\build-i18n.cjs') --check
  if ($LASTEXITCODE -ne 0) { throw '翻訳カタログの検査に失敗しました。node scripts/build-i18n.cjs を実行してください。' }
} else {
  Write-Warning 'Node.js が見つからないため、翻訳カタログの検査を省略しました。'
}

# 2. 必要なファイルがそろっているか
foreach ($file in $files) {
  if (-not (Test-Path (Join-Path $root $file) -PathType Leaf)) { throw "ファイルがありません: $file" }
}
foreach ($locale in $locales) {
  if (-not (Test-Path (Join-Path $root "_locales\$locale\messages.json") -PathType Leaf)) { throw "翻訳がありません: _locales/$locale/messages.json" }
}
foreach ($icon in $icons) {
  if (-not (Test-Path (Join-Path $root "icons\$icon") -PathType Leaf)) { throw "アイコンがありません: icons/$icon" }
}
$manifest = Get-Content -Raw -Encoding UTF8 (Join-Path $root 'manifest.json') | ConvertFrom-Json

# 3. 配布フォルダー
New-Item -ItemType Directory -Force -Path $dist | Out-Null
if (Test-Path $folder) { Remove-Item -Recurse -Force $folder }
New-Item -ItemType Directory -Force -Path $folder | Out-Null
foreach ($file in $files) {
  Copy-Item -LiteralPath (Join-Path $root $file) -Destination (Join-Path $folder $file)
}
foreach ($dir in $directories) {
  Copy-Item -LiteralPath (Join-Path $root $dir) -Destination (Join-Path $folder $dir) -Recurse
}

# 4. ZIP（エントリーの区切りは必ず "/"。Compress-Archive は "\" になることがあるため使わない）
function New-Zip([string]$source, [string]$destination, [string]$prefix) {
  if (Test-Path $destination) { Remove-Item -Force $destination }
  $archive = [System.IO.Compression.ZipFile]::Open($destination, [System.IO.Compression.ZipArchiveMode]::Create)
  try {
    $base = (Resolve-Path $source).Path.TrimEnd('\') + '\'
    Get-ChildItem -LiteralPath $source -Recurse -File | Sort-Object FullName | ForEach-Object {
      $relative = $_.FullName.Substring($base.Length).Replace('\', '/')
      $entryName = if ($prefix) { "$prefix/$relative" } else { $relative }
      [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
        $archive, $_.FullName, $entryName, [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
    }
  } finally {
    $archive.Dispose()
  }
}

New-Zip $folder $zipPath $folderName
New-Zip $folder $storeZipPath ''

# 5. 結果
$count = (Get-ChildItem -LiteralPath $folder -Recurse -File).Count
Write-Host "Version $($manifest.version) / $count files"
Write-Host "Folder : $folder"
Write-Host "ZIP    : $zipPath"
Write-Host "Store  : $storeZipPath"
