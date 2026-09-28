# น้องฝนเฝ้าบ้าน — ติดตั้ง ตั้งค่า และเปิดใช้งาน (Windows 10/11, PowerShell 5.1 ขึ้นไป)
#
#   install\nongfon.ps1              เมนู (ครั้งแรก = ติดตั้ง → ตั้งค่า → เปิด)
#   install\nongfon.ps1 install      ติดตั้งส่วนประกอบอย่างเดียว (ไม่ถามอะไร เหมาะกับ AI agent)
#   install\nongfon.ps1 setup        ตัวช่วยตั้งค่าทีละขั้น
#   install\nongfon.ps1 secrets      ใส่/เปลี่ยน API key และโทเคน (พิมพ์แล้วไม่แสดงบนจอ)
#   install\nongfon.ps1 start        เปิดน้องฝน (-NoBrowser = ไม่ต้องเปิดเบราว์เซอร์)
#   install\nongfon.ps1 doctor       ตรวจความพร้อม (doctor --online = ทดสอบคีย์และกล้องจริง)
#   install\nongfon.ps1 autostart on|off
#
# ไม่ต้องใช้สิทธิ์ admin: ถ้าเครื่องยังไม่มี Node.js 22 จะดาวน์โหลดตัวทางการจาก nodejs.org
# มาไว้ในโฟลเดอร์ .runtime ของน้องฝน และตรวจลายนิ้วมือ SHA-256 ก่อนใช้

param(
  [string]$Command = 'menu',
  [string]$Arg = '',
  [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$App = Split-Path -Parent $PSScriptRoot
$Runtime = Join-Path $App '.runtime'
$NodeMajor = 22
$FfmpegStaticVersion = '5.3.0'
Set-Location $App

function Say([string]$Text) { Write-Host $Text }
function Stop-WithError([string]$Text) { Write-Host "❌ $Text" -ForegroundColor Red; exit 1 }

function Test-NodeNewEnough {
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) { return $false }
  try { $major = [int](& node -p "process.versions.node.split('.')[0]") } catch { return $false }
  return $major -ge $NodeMajor
}

function Install-PortableNode {
  $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
  $base = "https://nodejs.org/dist/latest-v$NodeMajor.x"
  Say "⬇️  กำลังดาวน์โหลด Node.js $NodeMajor (ตัวทางการจาก nodejs.org) มาไว้ในโฟลเดอร์ .runtime"
  $sums = (Invoke-WebRequest "$base/SHASUMS256.txt" -UseBasicParsing).Content -split "`n" | ForEach-Object { $_.Trim() }
  $line = $sums | Where-Object { $_ -match "^[0-9a-f]{64}\s+node-v[\d.]+-win-$arch\.zip$" } | Select-Object -First 1
  if (-not $line) { Stop-WithError "ไม่พบ Node.js สำหรับ Windows $arch" }
  $parts = $line -split '\s+'
  $sha = $parts[0]
  $file = $parts[1]
  $tmp = Join-Path $env:TEMP ("nongfon-" + [guid]::NewGuid())
  New-Item -ItemType Directory -Path $tmp | Out-Null
  $zip = Join-Path $tmp $file
  Invoke-WebRequest "$base/$file" -OutFile $zip -UseBasicParsing
  $got = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
  if ($got -ne $sha.ToLower()) {
    Remove-Item $tmp -Recurse -Force
    Stop-WithError "ไฟล์ Node.js ที่ได้ไม่ตรงกับที่ nodejs.org ประกาศ — หยุดเพื่อความปลอดภัย"
  }
  $target = Join-Path $Runtime 'node'
  if (Test-Path $target) { Remove-Item $target -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $Runtime | Out-Null
  Expand-Archive $zip -DestinationPath $Runtime -Force
  Rename-Item (Join-Path $Runtime ($file -replace '\.zip$', '')) 'node'
  Remove-Item $tmp -Recurse -Force
  Say "✅ Node.js พร้อม (อยู่ในโฟลเดอร์น้องฝนเท่านั้น ไม่แตะระบบ)"
}

function Use-Node {
  $portable = Join-Path $Runtime 'node'
  if (Test-Path (Join-Path $portable 'node.exe')) { $env:Path = "$portable;$env:Path" }
  if (Test-NodeNewEnough) { return }
  Install-PortableNode
  $env:Path = "$portable;$env:Path"
}

function Test-HasFfmpeg {
  if (Get-Command ffmpeg -ErrorAction SilentlyContinue) { return $true }
  return Test-Path (Join-Path $App 'node_modules\ffmpeg-static\ffmpeg.exe')
}

function Invoke-Install {
  Say "☔ น้องฝนกำลังติดตั้งส่วนประกอบ…"
  Use-Node
  $lock = Join-Path $App 'package-lock.json'
  $marker = Join-Path $App 'node_modules\.package-lock.json'
  if (-not (Test-Path $marker) -or ((Get-Item $lock).LastWriteTime -gt (Get-Item $marker).LastWriteTime)) {
    & npm ci --omit=dev --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { Stop-WithError "ติดตั้งส่วนประกอบไม่สำเร็จ — เช็กอินเทอร์เน็ตแล้วลองใหม่" }
  }
  if (-not (Test-HasFfmpeg)) {
    Say "⬇️  เครื่องนี้ยังไม่มี ffmpeg (ใช้กับกล้อง RTSP) — กำลังเติมให้"
    & npm install --no-save --omit=dev --no-audit --no-fund "ffmpeg-static@$FfmpegStaticVersion"
    if ($LASTEXITCODE -ne 0) { Say "⚠️  เติม ffmpeg ไม่สำเร็จ — กล้องแบบลิงก์ภาพนิ่ง http:// ยังใช้ได้ ลองรันตัวติดตั้งใหม่ภายหลัง" }
  }
  Say "✅ ติดตั้งส่วนประกอบเสร็จแล้ว"
}

function Get-EnvValue([string]$Key, [string]$Default) {
  $file = Join-Path $App '.env'
  if (Test-Path $file) {
    $line = Get-Content $file -Encoding UTF8 | Where-Object { $_ -match "^$Key=" } | Select-Object -Last 1
    if ($line) {
      $value = ($line -replace "^$Key=", '' -replace '\s+#.*$', '').Trim().Trim('"', "'")
      if ($value) { return $value }
    }
  }
  return $Default
}

function Test-Healthy([string]$Port) {
  try {
    Invoke-WebRequest "http://127.0.0.1:$Port/healthz" -UseBasicParsing -TimeoutSec 2 | Out-Null
    return $true
  } catch {
    return $false
  }
}

function Invoke-Start {
  Use-Node
  if (-not (Test-Path (Join-Path $App 'node_modules'))) { Invoke-Install }
  if (-not (Test-Path (Join-Path $App '.env'))) { Stop-WithError "ยังไม่ได้ตั้งค่า — เลือกเมนู “ตั้งค่าใหม่ทั้งหมด” ก่อนนะคะ" }
  $port = Get-EnvValue 'PORT' '8080'
  $url = "http://localhost:$port"
  if (Test-Healthy $port) {
    Say "ℹ️  น้องฝนเปิดอยู่แล้วที่ $url"
    if (-not $NoBrowser) { Start-Process $url }
    return
  }
  Say "☔ กำลังเปิดน้องฝน… (ปิดหน้าต่างนี้ = หยุดเฝ้า)"
  if (-not $NoBrowser) {
    Start-Job -ArgumentList $port, $url -ScriptBlock {
      param($p, $u)
      for ($i = 0; $i -lt 90; $i++) {
        try { Invoke-WebRequest "http://127.0.0.1:$p/healthz" -UseBasicParsing -TimeoutSec 2 | Out-Null; Start-Process $u; return } catch { Start-Sleep -Seconds 1 }
      }
    } | Out-Null
  }
  & node src\main.js
}

function Invoke-Update {
  if (Test-Path (Join-Path $App '.git')) {
    & git pull --ff-only
    Invoke-Install
  } else {
    Say "ℹ️  อัปเดต: รันคำสั่งติดตั้งแบบบรรทัดเดียวอีกครั้ง (ไฟล์ .env และข้อมูลเดิมยังอยู่)"
  }
}

function Invoke-Menu {
  $firstRun = -not (Test-Path (Join-Path $App 'node_modules')) -or -not (Test-Path (Join-Path $App '.env'))
  if ($firstRun) {
    Invoke-Install
    if (-not (Test-Path (Join-Path $App '.env'))) { & node scripts\setup.js }
    if (-not (Test-Path (Join-Path $App '.env'))) { Stop-WithError "ยังไม่ได้บันทึกการตั้งค่า — ดับเบิลคลิกใหม่เมื่อพร้อมนะคะ" }
    & node scripts\doctor.js
    Invoke-Start
    return
  }
  Use-Node
  Say ""
  Say "☔ น้องฝนเฝ้าบ้าน — จะทำอะไรดีคะ?"
  Say "  1) เปิดน้องฝน"
  Say "  2) ตั้งค่าใหม่ทั้งหมด"
  Say "  3) ใส่/เปลี่ยน API key และโทเคน"
  Say "  4) ตรวจความพร้อม (ทดสอบคีย์และกล้องจริง)"
  Say "  5) ตั้งให้เปิดเองตอนเปิดเครื่อง"
  Say "  6) อัปเดตเป็นเวอร์ชันล่าสุด"
  Say "  7) ออก"
  $choice = Read-Host "  เลือกหมายเลข [1]"
  switch ($choice) {
    '' { Invoke-Start }
    '1' { Invoke-Start }
    '2' { & node scripts\setup.js }
    '3' { & node scripts\setup.js --secrets }
    '4' { & node scripts\doctor.js --online }
    '5' { & node scripts\autostart.js on }
    '6' { Invoke-Update }
    default { Say "แล้วเจอกันค่ะ ☔" }
  }
}

switch ($Command) {
  'install' { Invoke-Install }
  'setup' { Use-Node; & node scripts\setup.js }
  'secrets' { Use-Node; & node scripts\setup.js --secrets }
  'start' { Invoke-Start }
  'doctor' { Use-Node; if ($Arg) { & node scripts\doctor.js $Arg } else { & node scripts\doctor.js } }
  'autostart' { Use-Node; if ($Arg) { & node scripts\autostart.js $Arg } else { & node scripts\autostart.js status } }
  'update' { Invoke-Update }
  default { Invoke-Menu }
}
