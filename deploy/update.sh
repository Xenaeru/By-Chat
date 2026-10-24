#!/usr/bin/env bash
#
# deploy/update.sh — tarik commit terbaru, pasang ulang dependensi produksi,
# lalu restart service. Aman dijalankan berkali-kali.
#
# Pemakaian:
#   sudo bash deploy/update.sh

set -euo pipefail

APP_USER=bychat
SERVICE_NAME=secure-chat
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

say() { printf '\033[1;34m→\033[0m %s\n' "$*"; }
ok() { printf '\033[1;32m✓\033[0m %s\n' "$*"; }
die() {
	printf '\033[1;31m✗\033[0m %s\n' "$*" >&2
	exit 1
}

[[ $EUID -eq 0 ]] || die "Jalankan dengan sudo."
[[ -d "$APP_DIR/.git" ]] || die "$APP_DIR bukan repo git; pakai rsync manual lalu restart service."

cd "$APP_DIR"

# Repo bisa dimiliki user lain (mis. hasil clone manual), sementara skrip ini
# jalan sebagai root.
git config --system --add safe.directory "$APP_DIR" 2>/dev/null || true

before="$(git rev-parse --short HEAD)"
say "git pull --ff-only…"
git pull --ff-only
after="$(git rev-parse --short HEAD)"

if [[ "$before" == "$after" ]]; then
	say "Tidak ada commit baru ($after). Tetap lanjut memasang ulang dependensi."
fi

say "npm ci --omit=dev…"
npm ci --omit=dev --no-audit --no-fund
npm cache clean --force >/dev/null 2>&1 || true

# Folder data/ harus tetap bisa ditulis service setelah pull.
install -d -o "$APP_USER" -g "$APP_USER" -m 750 "$APP_DIR/data"
if [[ -f "$APP_DIR/.env" ]]; then
	chown root:"$APP_USER" "$APP_DIR/.env"
	chmod 640 "$APP_DIR/.env"
fi

PORT="$(sed -n 's/^[[:space:]]*PORT[[:space:]]*=[[:space:]]*\([0-9]\{1,5\}\).*/\1/p' "$APP_DIR/.env" 2>/dev/null | tail -1)"
PORT="${PORT:-3000}"

say "Restart $SERVICE_NAME…"
systemctl restart "$SERVICE_NAME"

for _ in $(seq 1 20); do
	if curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then
		ok "Sehat. Kode: $before → $after"
		exit 0
	fi
	sleep 1
done

die "Service belum menjawab /healthz. Cek: journalctl -u $SERVICE_NAME -n 50 --no-pager"
