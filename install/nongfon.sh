#!/usr/bin/env bash
# น้องฝนเฝ้าบ้าน — ติดตั้ง ตั้งค่า และเปิดใช้งาน (macOS / Linux)
#
#   bash install/nongfon.sh            เมนู (ครั้งแรก = ติดตั้ง → ตั้งค่า → เปิด)
#   bash install/nongfon.sh install    ติดตั้งส่วนประกอบอย่างเดียว (ไม่ถามอะไร เหมาะกับ AI agent)
#   bash install/nongfon.sh setup      ตัวช่วยตั้งค่าทีละขั้น
#   bash install/nongfon.sh secrets    ใส่/เปลี่ยน API key และโทเคน (พิมพ์แล้วไม่แสดงบนจอ)
#   bash install/nongfon.sh start      เปิดน้องฝน (--no-browser = ไม่ต้องเปิดเบราว์เซอร์)
#   bash install/nongfon.sh doctor     ตรวจความพร้อม (--online = ทดสอบคีย์และกล้องจริง)
#   bash install/nongfon.sh autostart on|off
#
# ไม่ต้องใช้สิทธิ์ admin: ถ้าเครื่องยังไม่มี Node.js 22 จะดาวน์โหลดตัวทางการจาก nodejs.org
# มาไว้ในโฟลเดอร์ .runtime ของน้องฝน และตรวจลายนิ้วมือ SHA-256 ก่อนใช้

set -euo pipefail

APP="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME="$APP/.runtime"
NODE_MAJOR=22
FFMPEG_STATIC_VERSION="5.3.0"
cd "$APP"

say() { printf '%s\n' "$*"; }
die() { printf '❌ %s\n' "$*" >&2; exit 1; }

sha256_of() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}'
  else sha256sum "$1" | awk '{print $1}'; fi
}

node_is_new_enough() {
  command -v node >/dev/null 2>&1 || return 1
  local major
  major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  [ "$major" -ge "$NODE_MAJOR" ] 2>/dev/null
}

portable_node() {
  local os arch plat cpu base sums file sha tmp got
  os="$(uname -s)"; arch="$(uname -m)"
  case "$os" in Darwin) plat=darwin ;; Linux) plat=linux ;; *) die "ระบบ $os ยังไม่รองรับ — ใช้ Docker แทนได้ (docker compose up -d)" ;; esac
  case "$arch" in arm64|aarch64) cpu=arm64 ;; x86_64|amd64) cpu=x64 ;; *) die "CPU แบบ $arch ยังไม่รองรับ" ;; esac
  base="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x"
  say "⬇️  กำลังดาวน์โหลด Node.js ${NODE_MAJOR} (ตัวทางการจาก nodejs.org) มาไว้ในโฟลเดอร์ .runtime"
  sums="$(curl -fsSL "$base/SHASUMS256.txt")" || die "ดาวน์โหลด Node.js ไม่ได้ — เช็กอินเทอร์เน็ตแล้วลองใหม่"
  file="$(printf '%s\n' "$sums" | awk -v want="-${plat}-${cpu}.tar.gz" '{ n = length($2) - length(want) + 1 } n > 0 && substr($2, n) == want && $2 ~ /^node-v/ { print $2; exit }')"
  [ -n "$file" ] || die "ไม่พบ Node.js สำหรับ ${plat}-${cpu}"
  sha="$(printf '%s\n' "$sums" | awk -v f="$file" '$2 == f { print $1 }')"
  tmp="$(mktemp -d)"
  curl -fL --progress-bar -o "$tmp/$file" "$base/$file" || { rm -rf "$tmp"; die "ดาวน์โหลด Node.js ไม่สำเร็จ"; }
  got="$(sha256_of "$tmp/$file")"
  if [ "$got" != "$sha" ]; then rm -rf "$tmp"; die "ไฟล์ Node.js ที่ได้ไม่ตรงกับที่ nodejs.org ประกาศ — หยุดเพื่อความปลอดภัย"; fi
  rm -rf "$RUNTIME/node"; mkdir -p "$RUNTIME"
  tar -xzf "$tmp/$file" -C "$RUNTIME"
  mv "$RUNTIME/${file%.tar.gz}" "$RUNTIME/node"
  rm -rf "$tmp"
  say "✅ Node.js $("$RUNTIME/node/bin/node" -v) พร้อม (อยู่ในโฟลเดอร์น้องฝนเท่านั้น ไม่แตะระบบ)"
}

ensure_node() {
  if [ -x "$RUNTIME/node/bin/node" ]; then export PATH="$RUNTIME/node/bin:$PATH"; fi
  if node_is_new_enough && [ -z "${NONGFON_FORCE_PORTABLE_NODE:-}" ]; then return 0; fi
  if [ -n "${NONGFON_FORCE_PORTABLE_NODE:-}" ] && [ -x "$RUNTIME/node/bin/node" ]; then return 0; fi
  portable_node
  export PATH="$RUNTIME/node/bin:$PATH"
}

has_ffmpeg() {
  command -v ffmpeg >/dev/null 2>&1 || [ -x "$APP/node_modules/ffmpeg-static/ffmpeg" ]
}

cmd_install() {
  say "☔ น้องฝนกำลังติดตั้งส่วนประกอบ…"
  ensure_node
  if [ ! -d node_modules ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
    npm ci --omit=dev --no-audit --no-fund
  fi
  if ! has_ffmpeg; then
    say "⬇️  เครื่องนี้ยังไม่มี ffmpeg (ใช้กับกล้อง RTSP) — กำลังเติมให้"
    npm install --no-save --omit=dev --no-audit --no-fund "ffmpeg-static@${FFMPEG_STATIC_VERSION}" \
      || say "⚠️  เติม ffmpeg ไม่สำเร็จ — กล้องแบบลิงก์ภาพนิ่ง http:// ยังใช้ได้ ลองรันตัวติดตั้งใหม่ภายหลัง"
  fi
  chmod +x "$APP"/*.command "$APP"/install/*.command "$APP"/install/*.sh 2>/dev/null || true
  say "✅ ติดตั้งส่วนประกอบเสร็จแล้ว"
}

env_value() { # env_value KEY DEFAULT → the value in .env
  local v=""
  if [ -f .env ]; then v="$(grep -E "^$1=" .env | tail -n 1 | cut -d= -f2- | tr -d "\"'" | sed 's/[[:space:]]#.*$//' || true)"; fi
  printf '%s' "${v:-$2}"
}

open_when_ready() { # open_when_ready PORT
  local url="http://localhost:$1"
  for _ in $(seq 1 90); do
    if curl -fsS -m 2 "http://127.0.0.1:$1/healthz" >/dev/null 2>&1; then
      say "🌐 เปิดหน้าเว็บ $url"
      if [ "$(uname -s)" = Darwin ]; then open "$url"; elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$url" >/dev/null 2>&1; fi
      return 0
    fi
    sleep 1
  done
}

cmd_start() {
  ensure_node
  [ -d node_modules ] || cmd_install
  [ -f .env ] || die "ยังไม่ได้ตั้งค่า — รัน bash install/nongfon.sh setup ก่อน"
  local port; port="$(env_value PORT 8080)"
  if curl -fsS -m 2 "http://127.0.0.1:$port/healthz" >/dev/null 2>&1; then
    say "ℹ️  น้องฝนเปิดอยู่แล้วที่ http://localhost:$port"
    [ "${1:-}" = "--no-browser" ] || { [ "$(uname -s)" = Darwin ] && open "http://localhost:$port"; } || true
    return 0
  fi
  say "☔ กำลังเปิดน้องฝน… (ปิดหน้าต่างนี้ = หยุดเฝ้า)"
  [ "${1:-}" = "--no-browser" ] || open_when_ready "$port" &
  if [ "$(uname -s)" = Darwin ]; then exec caffeinate -is node src/main.js; else exec node src/main.js; fi
}

cmd_update() {
  if [ -d .git ]; then git pull --ff-only && cmd_install
  else say "ℹ️  อัปเดต: รันคำสั่งติดตั้งแบบบรรทัดเดียวอีกครั้ง (ไฟล์ .env และข้อมูลเดิมยังอยู่)"; fi
}

cmd_menu() {
  if [ ! -d node_modules ] || [ ! -f .env ]; then
    cmd_install
    [ -f .env ] || node scripts/setup.js || true
    [ -f .env ] || die "ยังไม่ได้บันทึกการตั้งค่า — ดับเบิลคลิกใหม่เมื่อพร้อมนะคะ"
    node scripts/doctor.js || true
    cmd_start
    return
  fi
  ensure_node
  say ""
  say "☔ น้องฝนเฝ้าบ้าน — จะทำอะไรดีคะ?"
  say "  1) เปิดน้องฝน"
  say "  2) ตั้งค่าใหม่ทั้งหมด"
  say "  3) ใส่/เปลี่ยน API key และโทเคน"
  say "  4) ตรวจความพร้อม (ทดสอบคีย์และกล้องจริง)"
  say "  5) ตั้งให้เปิดเองตอนเปิดเครื่อง"
  say "  6) อัปเดตเป็นเวอร์ชันล่าสุด"
  say "  7) ออก"
  local choice; read -r -p "  เลือกหมายเลข [1] › " choice || choice=1
  case "${choice:-1}" in
    1) cmd_start ;;
    2) node scripts/setup.js ;;
    3) node scripts/setup.js --secrets ;;
    4) node scripts/doctor.js --online || true ;;
    5) node scripts/autostart.js on ;;
    6) cmd_update ;;
    *) say "แล้วเจอกันค่ะ ☔" ;;
  esac
}

case "${1:-menu}" in
  install) cmd_install ;;
  setup) ensure_node; node scripts/setup.js ;;
  secrets) ensure_node; node scripts/setup.js --secrets ;;
  start) shift; cmd_start "$@" ;;
  doctor) shift; ensure_node; node scripts/doctor.js "$@" ;;
  autostart) shift; ensure_node; node scripts/autostart.js "${1:-status}" ;;
  update) cmd_update ;;
  menu) cmd_menu ;;
  *) die "ไม่รู้จักคำสั่ง $1 (ใช้ install, setup, secrets, start, doctor, autostart, update)" ;;
esac
