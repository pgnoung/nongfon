#!/bin/bash
# เปิดน้องฝนตอนล็อกอิน (ถูกเรียกโดย npm run autostart -- on) — ปิดหน้าต่างนี้ = หยุดเฝ้า
cd "$(dirname "$0")/.." && exec bash install/nongfon.sh start --no-browser
