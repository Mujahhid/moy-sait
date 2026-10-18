#!/usr/bin/env bash
# Обновить сайт до последней версии из GitHub и перезапустить. Запускать от root.
set -euo pipefail
cd /opt/kutubul
git pull --ff-only
systemctl restart kutubul
sleep 2
curl -fsS http://127.0.0.1:3000/healthz >/dev/null && echo "Обновлено, сайт работает." || { journalctl -u kutubul -n 30 --no-pager; exit 1; }
