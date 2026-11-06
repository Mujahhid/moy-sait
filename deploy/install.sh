#!/usr/bin/env bash
# Установка библиотеки на чистый сервер Ubuntu 22.04 / 24.04 (облачный сервер Рег.ру и др.). Запускать от root.
#
#   Без домена (по IP, без HTTPS):   bash install.sh
#   С доменом (HTTPS автоматически): bash install.sh library.example.ru
#   Несколько доменов:               bash install.sh 'example.ru, www.example.ru'
#
# Переменные (необязательно):
#   REPO=https://github.com/Mujahhid/moy-sait.git          откуда брать код
#   GH_TOKEN=github_pat_...                              токен только для чтения, если репозиторий приватный
#   MAX_PDF_MB=500                                       максимальный размер одной книги
#
# Скрипт можно запускать повторно: настройки и данные не затираются, код обновится.
set -euo pipefail

DOMAIN="${1:-}"
REPO="${REPO:-https://github.com/Mujahhid/moy-sait.git}"
APP_DIR=/opt/kutubul
DATA_DIR=/var/lib/kutubul
ENV_FILE=/etc/kutubul.env
SVC_USER=kutubul

say() { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31mОшибка: %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "запустите от root (sudo -i)"
. /etc/os-release
case "${ID:-}" in ubuntu|debian) ;; *) die "нужен Ubuntu или Debian, найдено: ${ID:-неизвестно}" ;; esac

export DEBIAN_FRONTEND=noninteractive

say "Базовые пакеты"
apt-get update -y
apt-get install -y curl ca-certificates git gnupg apt-transport-https debian-keyring debian-archive-keyring

say "Node.js 22"
node_ok() { command -v node >/dev/null && node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)'; }
if ! node_ok; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
node_ok || die "не удалось поставить Node.js 22.13 или новее (сейчас: $(node -v 2>/dev/null || echo нет))"
echo "Node $(node -v)"

say "Caddy (веб-сервер с автоматическим HTTPS)"
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y
  apt-get install -y caddy
fi

say "Код сайта"
URL="$REPO"
[ -n "${GH_TOKEN:-}" ] && URL="${REPO/https:\/\//https://x-access-token:${GH_TOKEN}@}"
if [ -d "$APP_DIR/.git" ]; then
  [ -n "${GH_TOKEN:-}" ] && git -C "$APP_DIR" remote set-url origin "$URL"
  git -C "$APP_DIR" pull --ff-only
elif [ -f "$APP_DIR/server.js" ]; then
  echo "Код уже лежит в $APP_DIR (загружен вручную) — пропускаю скачивание."
else
  git clone "$URL" "$APP_DIR" || die "не удалось скачать код. Если репозиторий приватный — задайте GH_TOKEN (см. deploy/README.md)"
fi
[ -f "$APP_DIR/server.js" ] || die "в $APP_DIR нет server.js"

say "Пользователь и папка данных"
id "$SVC_USER" >/dev/null 2>&1 || useradd --system --home-dir "$DATA_DIR" --shell /usr/sbin/nologin "$SVC_USER"
mkdir -p "$DATA_DIR"
chown -R "$SVC_USER:$SVC_USER" "$DATA_DIR"
chmod 700 "$DATA_DIR"

say "Настройки ($ENV_FILE)"
if [ ! -f "$ENV_FILE" ]; then
  cat > "$ENV_FILE" <<ENVEOF
DATA_DIR=$DATA_DIR
PORT=3000
HOST=127.0.0.1
MAX_PDF_MB=${MAX_PDF_MB:-500}
# REGISTRATION=closed
# ADMIN_NICK=ваш_ник
ENVEOF
  chmod 600 "$ENV_FILE"
else
  echo "Файл уже есть — не трогаю."
fi

say "Служба systemd"
cat > /etc/systemd/system/kutubul.service <<UNITEOF
[Unit]
Description=maktabatul-ulum library
After=network-online.target
Wants=network-online.target

[Service]
User=$SVC_USER
Group=$SVC_USER
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
ExecStart=$(command -v node) server.js
Restart=always
RestartSec=2
LimitNOFILE=65536
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$DATA_DIR

[Install]
WantedBy=multi-user.target
UNITEOF
systemctl daemon-reload
systemctl enable kutubul >/dev/null
systemctl restart kutubul

say "Веб-сервер Caddy"
SITE=":80"
[ -n "$DOMAIN" ] && SITE="$DOMAIN"
cat > /etc/caddy/Caddyfile <<CADDYEOF
$SITE {
	reverse_proxy 127.0.0.1:3000 {
		transport http {
			keepalive 30s
		}
	}
}
CADDYEOF
systemctl enable caddy >/dev/null
systemctl restart caddy

if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
  say "Брандмауэр: открываю 80 и 443"
  ufw allow 80/tcp >/dev/null
  ufw allow 443/tcp >/dev/null
fi

say "Проверка"
ok=""
for _ in $(seq 1 20); do
  if curl -fsS http://127.0.0.1:3000/healthz >/dev/null 2>&1; then ok=1; break; fi
  sleep 1
done
[ -n "$ok" ] || { journalctl -u kutubul -n 30 --no-pager; die "сайт не запустился, смотрите журнал выше"; }

IP="$(curl -fsS4 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')"
echo
echo "Готово. Сайт работает."
if [ -n "$DOMAIN" ]; then
  echo "Адрес: https://$DOMAIN   (сертификат выпускается за несколько секунд; домен должен указывать на $IP)"
else
  echo "Адрес: http://$IP   (без домена HTTPS нет — скачивание книг для офлайна работать не будет)"
fi
echo "Дальше: откройте сайт, зарегистрируйтесь (первый пользователь становится админом) или восстановите резервную копию в «Управление библиотекой»."
echo "Журнал: journalctl -u kutubul -f      Обновление сайта: bash $APP_DIR/deploy/update.sh"
