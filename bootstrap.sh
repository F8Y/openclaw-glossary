#!/usr/bin/env bash
#
# bootstrap.sh — разовая подготовка Ubuntu 24.04.
# Дальше всё делает реконсиль-таймер, руками на сервер лазить не нужно.
set -euo pipefail

REPO_DIR=/opt/openclaw-dvb
STATE_DIR=/opt/openclaw-state

log() { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }

[[ $EUID -eq 0 ]] || { echo "Запускать через sudo"; exit 1; }

log "Базовые пакеты"
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg git jq ufw rsync age

log "Swap 2 ГБ (на 4 ГБ RAM без него ловится OOM при pull образов)"
if ! swapon --show | grep -q swapfile; then
    fallocate -l 2G /swapfile
    chmod 600 /swapfile
    mkswap -q /swapfile
    swapon /swapfile
    echo '/swapfile none swap sw 0 0' >> /etc/fstab
    echo 'vm.swappiness=10' > /etc/sysctl.d/99-swap.conf
    sysctl -q -p /etc/sysctl.d/99-swap.conf
fi

log "Docker Engine + Compose v2"
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
    | gpg --dearmor -o /etc/apt/keyrings/docker.gpg --yes
chmod a+r /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    > /etc/apt/sources.list.d/docker.list
apt-get update -qq
apt-get install -y -qq docker-ce docker-ce-cli containerd.io \
    docker-buildx-plugin docker-compose-plugin

log "Ротация логов Docker (иначе логи съедят 30 ГБ)"
mkdir -p /etc/docker
cat > /etc/docker/daemon.json <<'JSON'
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "3" },
  "live-restore": true
}
JSON
systemctl restart docker
systemctl enable -q docker

log "SOPS"
SOPS_VER=3.9.4
curl -fsSL -o /usr/local/bin/sops \
    "https://github.com/getsops/sops/releases/download/v${SOPS_VER}/sops-v${SOPS_VER}.linux.amd64"
chmod +x /usr/local/bin/sops
sops --version

log "Ключ age для расшифровки"
mkdir -p /root/.config/sops/age
if [[ ! -f /root/.config/sops/age/keys.txt ]]; then
    age-keygen -o /root/.config/sops/age/keys.txt 2>/dev/null
    chmod 600 /root/.config/sops/age/keys.txt
fi
PUBKEY="$(grep 'public key:' /root/.config/sops/age/keys.txt | awk '{print $NF}')"

log "Каталоги состояния"
mkdir -p "${STATE_DIR}"/{config,workspace,secrets}
# Образ работает под uid 1000 (node) — иначе EACCES при старте
chown -R 1000:1000 "$STATE_DIR"

log "Файрвол"
ufw default deny incoming  > /dev/null
ufw default allow outgoing > /dev/null
ufw allow 22/tcp comment ssh > /dev/null
ufw --force enable > /dev/null

log "systemd-юниты"
if [[ -d "${REPO_DIR}/deploy" ]]; then
    install -m 644 "${REPO_DIR}"/deploy/*.service "${REPO_DIR}"/deploy/*.timer /etc/systemd/system/
    chmod +x "${REPO_DIR}"/deploy/*.sh
    systemctl daemon-reload
    systemctl enable -q --now openclaw-reconcile.timer
    echo "Таймер включён."
else
    echo "ВНИМАНИЕ: ${REPO_DIR}/deploy не найден — склонируй репозиторий и перезапусти."
fi

cat <<EOF

────────────────────────────────────────────────────────────
Хост готов.

ПУБЛИЧНЫЙ AGE-КЛЮЧ (вписать в .sops.yaml, закоммитить):

  ${PUBKEY}

Приватный лежит в /root/.config/sops/age/keys.txt и с сервера
не выносится. Потеряешь — секреты не расшифровать, придётся
перевыпускать все токены.

Дальше:
  1. Впиши ключ в .sops.yaml, зашифруй secrets/openclaw.enc.yaml
  2. Разовый онбординг OpenClaw (см. README, «Первый запуск»)
  3. Забери сгенерированный GATEWAY_TOKEN в SOPS
  4. Промоуть main -> deploy через GitHub Actions

Диагностика:
  systemctl status openclaw-reconcile.timer
  journalctl -u openclaw-reconcile -f
────────────────────────────────────────────────────────────
EOF