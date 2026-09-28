#!/usr/bin/env bash
# ติดตั้งน้องฝนด้วยคำสั่งเดียว (macOS / Linux):
#   curl -fsSL https://raw.githubusercontent.com/pgnoung/nongfon/main/install/get.sh | bash
# ดาวน์โหลดโค้ดไปไว้ที่ ~/nongfon (เปลี่ยนได้ด้วย NONGFON_DIR) แล้วเปิดตัวช่วยตั้งค่า
# รันซ้ำได้เพื่ออัปเดต — ไฟล์ .env และข้อมูลเดิมในโฟลเดอร์ data จะไม่ถูกแตะ
set -euo pipefail
REPO="${NONGFON_REPO:-pgnoung/nongfon}"
BRANCH="${NONGFON_BRANCH:-main}"
DIR="${NONGFON_DIR:-$HOME/nongfon}"
URL="${NONGFON_TARBALL_URL:-https://codeload.github.com/$REPO/tar.gz/refs/heads/$BRANCH}"

echo "☔ น้องฝนกำลังดาวน์โหลดไปที่ $DIR"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
curl -fsSL "$URL" -o "$tmp/nongfon.tgz"
mkdir -p "$tmp/src"
tar -xzf "$tmp/nongfon.tgz" -C "$tmp/src" --strip-components=1
mkdir -p "$DIR"
cp -R "$tmp/src/." "$DIR/"
chmod +x "$DIR"/install/*.sh "$DIR"/install/*.command "$DIR"/*.command 2>/dev/null || true
cd "$DIR"
# a keyboard is attached (curl … | bash in a Terminal): open the guided menu; otherwise (an AI agent) just install
if (exec </dev/tty) 2>/dev/null; then exec bash install/nongfon.sh menu </dev/tty; fi
exec bash install/nongfon.sh install
