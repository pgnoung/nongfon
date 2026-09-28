# ติดตั้งน้องฝนด้วยคำสั่งเดียว (Windows PowerShell):
#   irm https://raw.githubusercontent.com/pgnoung/nongfon/main/install/get.ps1 | iex
# ดาวน์โหลดโค้ดไปไว้ที่ %USERPROFILE%\nongfon (เปลี่ยนได้ด้วย $env:NONGFON_DIR) แล้วเปิดตัวช่วยตั้งค่า
# รันซ้ำได้เพื่ออัปเดต — ไฟล์ .env และข้อมูลเดิมในโฟลเดอร์ data จะไม่ถูกแตะ
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$Repo = if ($env:NONGFON_REPO) { $env:NONGFON_REPO } else { 'pgnoung/nongfon' }
$Dir = if ($env:NONGFON_DIR) { $env:NONGFON_DIR } else { Join-Path $HOME 'nongfon' }
Write-Host "☔ น้องฝนกำลังดาวน์โหลดไปที่ $Dir"
$tmp = Join-Path $env:TEMP ("nongfon-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $tmp | Out-Null
$zip = Join-Path $tmp 'nongfon.zip'
Invoke-WebRequest "https://codeload.github.com/$Repo/zip/refs/heads/main" -OutFile $zip -UseBasicParsing
Expand-Archive $zip -DestinationPath (Join-Path $tmp 'src') -Force
$src = Get-ChildItem (Join-Path $tmp 'src') | Select-Object -First 1
New-Item -ItemType Directory -Force -Path $Dir | Out-Null
Copy-Item -Path (Join-Path $src.FullName '*') -Destination $Dir -Recurse -Force
Remove-Item $tmp -Recurse -Force
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Dir 'install\nongfon.ps1') menu
