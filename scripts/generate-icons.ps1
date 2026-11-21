# 拡張機能アイコン (16/32/48/128px) を再生成する
#   powershell -ExecutionPolicy Bypass -File scripts/generate-icons.ps1
#
# 意匠: 角丸の濃い背景 (#163a3b) に、白い塗りの三角形 (8,5)→(18,12)→(8,19) と
# x=4, y=6〜18 の白線 (太さ2.4・丸い端)。viewBox 24 の図形を背景の 21/32 の大きさで中央に置く。
# 128px は Chrome Web Store の推奨どおり周囲16pxを透明にし、96px の絵柄にする。

param(
  [string]$OutDir = (Join-Path $PSScriptRoot '..\icons')
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

function New-RoundedRect([single]$x, [single]$y, [single]$w, [single]$h, [single]$r) {
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $r * 2
  $path.AddArc($x, $y, $d, $d, 180, 90)
  $path.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
  $path.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
  $path.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
  $path.CloseFigure()
  return $path
}

function Write-Icon([int]$size, [string]$file) {
  $scale = 8
  $big = $size * $scale
  $canvas = New-Object System.Drawing.Bitmap $big, $big, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($canvas)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.Clear([System.Drawing.Color]::Transparent)

  $pad = if ($size -ge 128) { [single](16 / 128 * $big) } else { [single]0 }
  $box = [single]($big - 2 * $pad)
  $background = New-RoundedRect $pad $pad $box $box ([single]($box * 10 / 32))
  $bgBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 0x16, 0x3a, 0x3b))
  $g.FillPath($bgBrush, $background)

  $glyph = [single]($box * 21 / 32)
  $unit = [single]($glyph / 24)
  $origin = [single]($pad + ($box - $glyph) / 2)
  function P([single]$px, [single]$py) {
    New-Object System.Drawing.PointF ([single]($origin + $px * $unit)), ([single]($origin + $py * $unit))
  }

  $white = [System.Drawing.Color]::White
  $fill = New-Object System.Drawing.SolidBrush $white
  [System.Drawing.PointF[]]$triangle = @((P 8 5), (P 18 12), (P 8 19))
  $g.FillPolygon($fill, $triangle)

  $pen = New-Object System.Drawing.Pen $white, ([single](2.4 * $unit))
  $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  $g.DrawLine($pen, (P 4 6), (P 4 18))
  $g.Dispose()

  $out = New-Object System.Drawing.Bitmap $size, $size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g2 = [System.Drawing.Graphics]::FromImage($out)
  $g2.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
  $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g2.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g2.Clear([System.Drawing.Color]::Transparent)
  $g2.DrawImage($canvas, 0, 0, $size, $size)
  $g2.Dispose()
  $out.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)
  $out.Dispose()
  $canvas.Dispose()
}

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
foreach ($size in 16, 32, 48, 128) {
  $file = Join-Path (Resolve-Path $OutDir) "icon$size.png"
  Write-Icon $size $file
  Write-Host "作成: icons/icon$size.png"
}
