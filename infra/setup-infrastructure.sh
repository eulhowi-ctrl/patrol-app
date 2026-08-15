#!/usr/bin/env bash
#
# setup-infrastructure.sh
# Oracle Cloud Free Tier (VM.Standard.E2.1.Micro, 1 vCPU / 1GB RAM, Ubuntu x86_64) 대상
# Swap 메모리, Docker/Docker Compose, Nginx 리버스 프록시, Let's Encrypt SSL을 자동 설정한다.
#
# 사용법:
#   sudo DOMAIN=patrol.example.com EMAIL=you@example.com ./setup-infrastructure.sh
#   (환경변수를 넘기지 않으면 스크립트가 직접 물어본다)

set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "[오류] root 권한으로 실행해야 합니다. 'sudo $0' 으로 다시 실행하세요." >&2
  exit 1
fi

SWAP_FILE="/swapfile"
SWAP_SIZE_GB="2"
PROJECT_DIR="/opt/patrol-app"
BACKEND_PORT="3000"

log() { echo -e "\n[INFO] $*"; }

# ---------------------------------------------------------------------------
# 1. Swap 메모리 설정 (1GB RAM OOM 방지)
# ---------------------------------------------------------------------------
log "1/6 Swap 메모리 설정 확인 중..."
if swapon --show | grep -q "${SWAP_FILE}"; then
  log "이미 ${SWAP_FILE} 스왑이 활성화되어 있습니다. 건너뜁니다."
else
  if [[ -f "${SWAP_FILE}" ]]; then
    log "기존 ${SWAP_FILE} 파일이 존재하지만 활성화되어 있지 않습니다. 재사용합니다."
  else
    log "${SWAP_SIZE_GB}GB 스왑 파일 생성 중..."
    fallocate -l "${SWAP_SIZE_GB}G" "${SWAP_FILE}" || dd if=/dev/zero of="${SWAP_FILE}" bs=1M count=$((SWAP_SIZE_GB * 1024))
    chmod 600 "${SWAP_FILE}"
    mkswap "${SWAP_FILE}"
  fi
  swapon "${SWAP_FILE}"
  if ! grep -q "${SWAP_FILE}" /etc/fstab; then
    echo "${SWAP_FILE} none swap sw 0 0" >> /etc/fstab
  fi
  # 저사양 인스턴스에서 스왑을 적극적으로 활용하되 스와핑을 과도하게 유발하지 않도록 조정
  sysctl -w vm.swappiness=10
  if ! grep -q "vm.swappiness" /etc/sysctl.conf; then
    echo "vm.swappiness=10" >> /etc/sysctl.conf
  fi
  log "스왑 설정 완료 (${SWAP_SIZE_GB}GB)."
fi
free -h

# ---------------------------------------------------------------------------
# 2. 시스템 패키지 업데이트
# ---------------------------------------------------------------------------
log "2/6 시스템 패키지 업데이트 중..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get upgrade -y
apt-get install -y ca-certificates curl gnupg lsb-release ufw

# ---------------------------------------------------------------------------
# 3. Docker / Docker Compose 설치
# ---------------------------------------------------------------------------
log "3/6 Docker 설치 확인 중..."
if command -v docker &>/dev/null; then
  log "Docker가 이미 설치되어 있습니다: $(docker --version)"
else
  log "Docker 설치 중 (공식 편의 스크립트 사용)..."
  curl -fsSL https://get.docker.com -o /tmp/get-docker.sh
  sh /tmp/get-docker.sh
  rm -f /tmp/get-docker.sh
fi

if ! docker compose version &>/dev/null; then
  log "docker compose 플러그인 설치 중..."
  apt-get install -y docker-compose-plugin
fi

systemctl enable docker
systemctl start docker

# 1GB RAM 환경에서 빌드 시 OOM을 줄이기 위한 daemon 설정 (로그 크기 제한)
mkdir -p /etc/docker
cat > /etc/docker/daemon.json <<'EOF'
{
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "10m",
    "max-file": "3"
  }
}
EOF
systemctl restart docker

log "Docker 설치 완료: $(docker --version)"

# ---------------------------------------------------------------------------
# 4. 방화벽 설정
# ---------------------------------------------------------------------------
log "4/6 방화벽(ufw) 설정 중..."
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

# ---------------------------------------------------------------------------
# 5. Nginx + Let's Encrypt(Certbot) 설정
# ---------------------------------------------------------------------------
log "5/6 Nginx / Certbot 설치 및 SSL 설정 중..."
apt-get install -y nginx certbot python3-certbot-nginx

DOMAIN="${DOMAIN:-}"
EMAIL="${EMAIL:-}"

if [[ -z "${DOMAIN}" ]]; then
  read -rp "도메인을 입력하세요 (예: patrol.example.com): " DOMAIN
fi
if [[ -z "${EMAIL}" ]]; then
  read -rp "Let's Encrypt 알림용 이메일을 입력하세요: " EMAIL
fi

if [[ -z "${DOMAIN}" || -z "${EMAIL}" ]]; then
  echo "[오류] DOMAIN / EMAIL 값이 필요합니다." >&2
  exit 1
fi

NGINX_SITE="/etc/nginx/sites-available/patrol-app"
cat > "${NGINX_SITE}" <<EOF
server {
    listen 80;
    server_name ${DOMAIN};

    location / {
        proxy_pass http://127.0.0.1:${BACKEND_PORT};
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
EOF

ln -sf "${NGINX_SITE}" /etc/nginx/sites-enabled/patrol-app
rm -f /etc/nginx/sites-enabled/default

nginx -t
systemctl reload nginx

log "Certbot으로 HTTPS 인증서 발급 중 (${DOMAIN})..."
certbot --nginx -d "${DOMAIN}" -m "${EMAIL}" --agree-tos --non-interactive --redirect

# certbot 패키지 설치 시 갱신용 systemd timer(certbot.timer)가 자동 등록된다.
systemctl enable certbot.timer
systemctl start certbot.timer
log "인증서 자동 갱신 타이머 활성화 완료 (certbot.timer)."

# ---------------------------------------------------------------------------
# 6. 안내 출력
# ---------------------------------------------------------------------------
# 주의: docker-compose.yml의 backend 빌드 컨텍스트(../web)는 이 저장소의
# infra/ + web/ 디렉토리 구조를 그대로 유지해야 동작한다. docker-compose.yml만
# 따로 복사하면 build context 경로가 깨지므로, 저장소 전체를 git clone하고
# infra/ 디렉토리에서 직접 docker compose를 실행해야 한다.
log "6/6 완료. 저장소 전체를 clone하여 실행하세요."

cat <<EOF

================================================================
 인프라 설정 완료
================================================================
 - Swap:      $(swapon --show | tail -n +2)
 - Docker:    $(docker --version)
 - Nginx:     활성 상태 (도메인: ${DOMAIN}, HTTPS 적용됨)
 - 인증서 갱신: certbot.timer 활성화

 다음 단계 (저장소 전체를 clone한 뒤 infra/에서 실행):
   git clone <YOUR_REPO_URL> ${PROJECT_DIR}
   cd ${PROJECT_DIR}/infra
   cp ../web/.env.example ../web/.env   # 값 채운 뒤
   docker compose up -d --build
================================================================
EOF
