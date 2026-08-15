#!/usr/bin/env bash
#
# deploy-and-push.sh
# 1) 테스트 하네스를 실행해 핵심 파이프라인을 검증하고
# 2) 통과한 경우에만 GitHub 원격 저장소에 커밋/푸시한다.
#
# 환경변수 (없으면 대화형으로 입력받음):
#   GITHUB_REPO_URL   예) https://github.com/USER/REPO.git
#   GIT_USER_NAME
#   GIT_USER_EMAIL
#   GITHUB_PAT        Personal Access Token (repo 스코프). 저장소에 절대 커밋되지 않음.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${ROOT_DIR}"

log() { echo -e "\n[deploy] $*"; }

# ---------------------------------------------------------------------------
# 1. 테스트 하네스 실행 — 실패 시 즉시 중단 (실패한 코드를 push하지 않기 위함)
# ---------------------------------------------------------------------------
log "1/3 테스트 하네스 실행 중..."
pushd test >/dev/null
if [[ ! -d node_modules ]]; then
  npm install
fi
if ! npm test; then
  echo "[deploy] 테스트 실패 — 배포를 중단합니다." >&2
  popd >/dev/null
  exit 1
fi
popd >/dev/null
log "테스트 통과."

# ---------------------------------------------------------------------------
# 2. Git 사용자/원격 저장소 설정
# ---------------------------------------------------------------------------
log "2/3 Git 설정 중..."

GITHUB_REPO_URL="${GITHUB_REPO_URL:-}"
GIT_USER_NAME="${GIT_USER_NAME:-}"
GIT_USER_EMAIL="${GIT_USER_EMAIL:-}"
GITHUB_PAT="${GITHUB_PAT:-}"

[[ -z "${GITHUB_REPO_URL}" ]] && read -rp "GitHub Repository URL (예: https://github.com/USER/REPO.git): " GITHUB_REPO_URL
[[ -z "${GIT_USER_NAME}" ]] && read -rp "Git 사용자 이름: " GIT_USER_NAME
[[ -z "${GIT_USER_EMAIL}" ]] && read -rp "Git 이메일: " GIT_USER_EMAIL
[[ -z "${GITHUB_PAT}" ]] && read -rsp "GitHub Personal Access Token: " GITHUB_PAT && echo

if [[ -z "${GITHUB_REPO_URL}" || -z "${GIT_USER_NAME}" || -z "${GIT_USER_EMAIL}" || -z "${GITHUB_PAT}" ]]; then
  echo "[deploy] 필수 값이 비어 있습니다. 중단합니다." >&2
  exit 1
fi

if [[ ! -d .git ]]; then
  git init
  git branch -M main
fi

git config user.name "${GIT_USER_NAME}"
git config user.email "${GIT_USER_EMAIL}"

# PAT는 git 설정 파일에 영구 저장하지 않고, 이번 push 명령에만 사용되는 URL로 구성한다.
AUTH_URL=$(echo "${GITHUB_REPO_URL}" | sed -E "s#https://#https://${GIT_USER_NAME}:${GITHUB_PAT}@#")

if git remote get-url origin &>/dev/null; then
  git remote set-url origin "${GITHUB_REPO_URL}"
else
  git remote add origin "${GITHUB_REPO_URL}"
fi

# ---------------------------------------------------------------------------
# 3. 커밋 및 푸시
# ---------------------------------------------------------------------------
log "3/3 커밋 및 푸시 중..."
git add .

if git diff --cached --quiet; then
  log "변경 사항이 없어 커밋을 건너뜁니다."
else
  git commit -m "Feat: Complete On-Device AI Safety Patrol System Integration"
fi

git push "${AUTH_URL}" HEAD:main -u

log "배포 및 푸시 완료."
