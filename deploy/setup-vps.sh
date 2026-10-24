#!/usr/bin/env bash
#
# deploy/setup-vps.sh — pasang By Chat di VPS Debian/Ubuntu sebagai service
# systemd di belakang Caddy (HTTPS otomatis).
#
# Pemakaian:
#   sudo bash deploy/setup-vps.sh bychat.my.id
#
# Opsi lewat variabel lingkungan:
#   DRY_RUN=1        hanya cetak unit + Caddyfile hasil render, tidak menyentuh sistem
#   SWAP_MB=1024     ukuran /swapfile yang dibuat kalau belum ada swap (0 = lewati)
#   WITH_FIREWALL=1  aktifkan ufw (allow OpenSSH, 80, 443)
#   APP_PORT=3000    port lokal aplikasi; default dibaca dari .env
#
# Yang dilakukan skrip ini:
#   1. pasang Node.js 22 LTS (NodeSource) dan Caddy (repo resmi) bila belum ada
#   2. buat user sistem `bychat` + folder data/
#   3. npm ci --omit=dev (devDependencies seperti puppeteer tidak ikut)
#   4. pasang unit systemd dan Caddyfile dari template di folder ini
#   5. nyalakan service, lalu tunggu /healthz di localhost
#
# Yang TIDAK dilakukan: menulis .env, mengatur DNS, dan mendaftarkan domain ke
# Firebase. Ketiganya manual — lihat docs/DEPLOY-VPS.md.

set -euo pipefail

APP_USER=bychat
SERVICE_NAME=secure-chat
DOMAIN="${1:-}"
DRY_RUN="${DRY_RUN:-0}"
SWAP_MB="${SWAP_MB:-1024}"
WITH_FIREWALL="${WITH_FIREWALL:-0}"
APP_PORT="${APP_PORT:-}"

say() { printf '\033[1;34m→\033[0m %s\n' "$*"; }
ok() { printf '\033[1;32m✓\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!\033[0m %s\n' "$*" >&2; }
die() {
	printf '\033[1;31m✗\033[0m %s\n' "$*" >&2
	exit 1
}

[[ -n "$DOMAIN" ]] || die "Pakai: sudo bash deploy/setup-vps.sh domain-kamu (contoh: bychat.my.id)"
[[ "$DOMAIN" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]] ||
	die "Domain '$DOMAIN' tidak valid. Tulis tanpa https:// dan tanpa garis miring."

# Root folder aplikasi = satu level di atas folder deploy/ ini, jadi repo boleh
# berada di mana saja (/opt/bychat/app, /srv/bychat, dst).
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[[ -f "$APP_DIR/package.json" && -f "$APP_DIR/src/server.js" ]] ||
	die "$APP_DIR bukan folder aplikasi By Chat."

NODE_BIN="$(command -v node || echo /usr/bin/node)"

# Port yang dipakai Caddy untuk menghubungi aplikasi. Aplikasi membaca PORT
# dari .env; kalau tidak ada, src/config.js memakai 3000.
if [[ -z "$APP_PORT" && -f "$APP_DIR/.env" ]]; then
	APP_PORT="$(sed -n 's/^[[:space:]]*PORT[[:space:]]*=[[:space:]]*\([0-9]\{1,5\}\).*/\1/p' "$APP_DIR/.env" | tail -1)"
fi
APP_PORT="${APP_PORT:-3000}"

render() {
	local content
	content="$(cat "$1")"
	content="${content//@APP_DIR@/$APP_DIR}"
	content="${content//@APP_USER@/$APP_USER}"
	content="${content//@NODE_BIN@/$NODE_BIN}"
	content="${content//@APP_PORT@/$APP_PORT}"
	content="${content//@DOMAIN@/$DOMAIN}"
	printf '%s\n' "$content"
}

if [[ "$DRY_RUN" == 1 ]]; then
	echo "===== /etc/systemd/system/$SERVICE_NAME.service ====="
	render "$APP_DIR/deploy/secure-chat.service.in"
	echo
	echo "===== /etc/caddy/Caddyfile ====="
	render "$APP_DIR/deploy/Caddyfile.in"
	echo
	ok "DRY_RUN=1 — tidak ada yang dipasang."
	exit 0
fi

[[ $EUID -eq 0 ]] || die "Jalankan dengan sudo."
command -v apt-get >/dev/null || die "Skrip ini untuk Debian/Ubuntu (butuh apt-get)."

case "$APP_DIR" in
/home/*) warn "Aplikasi ada di $APP_DIR (di bawah /home). Sebaiknya pindahkan ke /opt/bychat/app." ;;
esac

[[ -f "$APP_DIR/.env" ]] || die "Belum ada $APP_DIR/.env. Jalankan: cp .env.example .env, isi, lalu npm run check-env"

if ! grep -Eq '^[[:space:]]*NODE_ENV[[:space:]]*=[[:space:]]*production[[:space:]]*$' "$APP_DIR/.env"; then
	die "NODE_ENV di .env harus production. Mode dev mempercayai uid apa pun yang dikirim browser."
fi

if ! grep -Eq '^[[:space:]]*STORAGE_DRIVER[[:space:]]*=[[:space:]]*supabase[[:space:]]*$' "$APP_DIR/.env"; then
	warn "STORAGE_DRIVER bukan supabase: lampiran, registry username, dan foto profil akan disimpan di disk VPS."
	warn "Di VPS berdisk 4 GB, isi bucket Supabase jauh lebih aman. Lihat docs/DEPLOY-VPS.md."
fi

say "Memasang paket dasar…"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg git

# --- Node.js 22 LTS ------------------------------------------------------
current_major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if ((current_major < 22 || current_major >= 27)); then
	say "Memasang Node.js 22 LTS dari NodeSource…"
	curl -fsSL https://deb.nodesource.com/setup_22.x -o /tmp/nodesource_setup.sh
	bash /tmp/nodesource_setup.sh >/dev/null
	apt-get install -y -qq nodejs
	NODE_BIN="$(command -v node)"
fi
node_major="$(node -p 'process.versions.node.split(".")[0]')"
((node_major >= 22 && node_major < 27)) || die "Node $(node -v) tidak cocok; package.json butuh >=22 <27."
ok "Node $(node -v) di $NODE_BIN"

# --- Caddy ---------------------------------------------------------------
if ! command -v caddy >/dev/null; then
	say "Memasang Caddy dari repo resmi…"
	apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https
	curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' |
		gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
	chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg
	curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
		> /etc/apt/sources.list.d/caddy-stable.list
	apt-get update -qq
	apt-get install -y -qq caddy
fi
ok "Caddy $(caddy version | head -1)"

# --- User + folder -------------------------------------------------------
if ! id -u "$APP_USER" >/dev/null 2>&1; then
	say "Membuat user sistem $APP_USER…"
	useradd --system --home-dir "/var/lib/$APP_USER" --create-home --shell /usr/sbin/nologin "$APP_USER"
fi
install -d -o "$APP_USER" -g "$APP_USER" -m 750 "$APP_DIR/data"

# .env tetap milik root tapi harus bisa dibaca service (aplikasi mem-parse
# sendiri isinya). 640 mencegah user lain di VPS membaca rahasianya.
chown root:"$APP_USER" "$APP_DIR/.env"
chmod 640 "$APP_DIR/.env"

# git pull dijalankan sebagai root, sementara repo mungkin dimiliki user lain.
if [[ "$(stat -c '%U' "$APP_DIR")" != root ]]; then
	git config --system --add safe.directory "$APP_DIR" || true
fi

# --- Dependensi ----------------------------------------------------------
if [[ -f "$APP_DIR/package-lock.json" ]]; then
	say "npm ci --omit=dev…"
	(cd "$APP_DIR" && npm ci --omit=dev --no-audit --no-fund)
else
	say "Tidak ada package-lock.json, memakai npm install --omit=dev…"
	(cd "$APP_DIR" && npm install --omit=dev --no-audit --no-fund)
fi
# Cache npm bisa ratusan MB; di disk 4 GB itu sayang.
npm cache clean --force >/dev/null 2>&1 || true
ok "Dependensi terpasang"

# --- systemd -------------------------------------------------------------
unit_tmp="$(mktemp)"
render "$APP_DIR/deploy/secure-chat.service.in" >"$unit_tmp"
install -m 644 "$unit_tmp" "/etc/systemd/system/$SERVICE_NAME.service"
rm -f "$unit_tmp"
systemctl daemon-reload
systemctl enable "$SERVICE_NAME" >/dev/null
ok "Unit /etc/systemd/system/$SERVICE_NAME.service terpasang"

# --- Caddyfile -----------------------------------------------------------
if [[ -f /etc/caddy/Caddyfile ]]; then
	cp /etc/caddy/Caddyfile "/etc/caddy/Caddyfile.bak.$(date +%Y%m%d%H%M%S)"
fi
caddyfile_tmp="$(mktemp)"
render "$APP_DIR/deploy/Caddyfile.in" >"$caddyfile_tmp"
install -m 644 "$caddyfile_tmp" /etc/caddy/Caddyfile
rm -f "$caddyfile_tmp"
caddy fmt --overwrite /etc/caddy/Caddyfile >/dev/null
caddy validate --config /etc/caddy/Caddyfile >/dev/null || die "Caddyfile tidak valid (lihat: caddy validate --config /etc/caddy/Caddyfile)"
ok "Caddyfile untuk $DOMAIN terpasang"

# --- Swap ----------------------------------------------------------------
if ((SWAP_MB > 0)) && ! swapon --show | grep -q . && [[ ! -f /swapfile ]]; then
	avail_mb="$(df --output=avail -m / | tail -1 | tr -d ' ')"
	if ((avail_mb > SWAP_MB + 512)); then
		say "Membuat swap ${SWAP_MB} MB (RAM 2 GB mudah habis saat deploy/restart)…"
		fallocate -l "${SWAP_MB}M" /swapfile || dd if=/dev/zero of=/swapfile bs=1M count="$SWAP_MB" status=none
		chmod 600 /swapfile
		mkswap /swapfile >/dev/null
		swapon /swapfile
		grep -q '^/swapfile[[:space:]]' /etc/fstab || echo '/swapfile none swap sw 0 0' >>/etc/fstab
		ok "Swap aktif"
	else
		warn "Sisa disk ${avail_mb} MB, tidak cukup untuk swap ${SWAP_MB} MB. Dilewati."
	fi
fi

# --- Firewall ------------------------------------------------------------
if [[ "$WITH_FIREWALL" == 1 ]]; then
	apt-get install -y -qq ufw
	ufw allow OpenSSH >/dev/null
	ufw allow 80/tcp >/dev/null
	ufw allow 443/tcp >/dev/null
	ufw --force enable >/dev/null
	ok "ufw aktif (22, 80, 443). Port $APP_PORT tidak dibuka."
else
	say "ufw dilewati. Kalau mau: sudo WITH_FIREWALL=1 bash deploy/setup-vps.sh $DOMAIN"
	warn "Pastikan port $APP_PORT tidak terbuka ke internet — hanya Caddy yang perlu menghubunginya."
fi

# --- Nyalakan ------------------------------------------------------------
say "Menjalankan service…"
systemctl restart "$SERVICE_NAME"
systemctl reload caddy 2>/dev/null || systemctl restart caddy

healthy=0
for _ in $(seq 1 20); do
	if curl -fsS "http://127.0.0.1:$APP_PORT/healthz" >/dev/null 2>&1; then
		healthy=1
		break
	fi
	sleep 1
done

if ((healthy == 1)); then
	ok "Aplikasi menjawab di 127.0.0.1:$APP_PORT/healthz"
else
	warn "Aplikasi belum menjawab di port $APP_PORT. Cek: journalctl -u $SERVICE_NAME -n 50 --no-pager"
fi

cat <<EOF

Langkah manual yang masih tersisa:
  1. Record A  $DOMAIN  →  IP publik VPS ini (registrar .my.id).
     Cek: dig +short $DOMAIN
  2. Firebase Console → Authentication → Settings → Authorized domains
     tambahkan: $DOMAIN
  3. Verifikasi dari mesin lokal:
     npm run verify-token -- https://$DOMAIN

Perintah harian:
  systemctl status $SERVICE_NAME
  journalctl -u $SERVICE_NAME -f
  sudo bash deploy/update.sh          # tarik kode baru + restart
EOF
