#!/usr/bin/env bash
#
# build-android.sh
# @bubblewrap/cli로 PWA를 TWA(Trusted Web Activity)로 패키징해 .aab를 생성한다.
#
# 필수 준비물 (사용자가 직접 보유해야 하는 항목):
#   - JDK 17+, Android SDK (bubblewrap이 최초 실행 시 자동 설치를 시도함)
#   - Google Play 앱 서명 키 (android.keystore) 및 비밀번호
#   - 배포 대상 도메인이 실제로 web/ 앱을 HTTPS로 서빙 중이어야 함 (twa-manifest.json의 host)
#
# 환경변수:
#   KEYSTORE_PASSWORD, KEY_PASSWORD  (필수, 키스토어/키 비밀번호. 절대 코드/저장소에 하드코딩 금지)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${SCRIPT_DIR}"

if ! command -v npx &>/dev/null; then
  echo "[오류] Node.js/npx가 필요합니다." >&2
  exit 1
fi

if [[ ! -f "twa-manifest.json" ]]; then
  echo "[오류] twa-manifest.json을 찾을 수 없습니다." >&2
  exit 1
fi

if grep -q "REPLACE_WITH_YOUR_DOMAIN" twa-manifest.json; then
  echo "[오류] twa-manifest.json의 REPLACE_WITH_YOUR_DOMAIN 값을 실제 도메인으로 먼저 교체하세요." >&2
  exit 1
fi

if [[ ! -f "android.keystore" ]]; then
  echo "[안내] android.keystore가 없습니다. 새로 생성합니다 (최초 1회만 실행, 이후 절대 분실/변경 금지)."
  read -rsp "새 키스토어 비밀번호를 입력하세요: " KEYSTORE_PASSWORD
  echo
  read -rsp "키 비밀번호를 입력하세요 (동일해도 무방): " KEY_PASSWORD
  echo
  keytool -genkeypair -v \
    -keystore android.keystore \
    -alias patrol-app \
    -keyalg RSA -keysize 2048 -validity 10000 \
    -storepass "${KEYSTORE_PASSWORD}" \
    -keypass "${KEY_PASSWORD}"
else
  : "${KEYSTORE_PASSWORD:?환경변수 KEYSTORE_PASSWORD를 설정하세요 (기존 android.keystore 비밀번호)}"
  : "${KEY_PASSWORD:?환경변수 KEY_PASSWORD를 설정하세요}"
fi

echo "[1/3] Google Play 서명 인증서 SHA-256 지문 추출 중..."
FINGERPRINT_COLON=$(keytool -list -v -keystore android.keystore -alias patrol-app -storepass "${KEYSTORE_PASSWORD}" \
  | grep "SHA256:" | sed 's/.*SHA256: //')

echo "     지문: ${FINGERPRINT_COLON}"

ASSETLINKS_PATH="../web/public/.well-known/assetlinks.json"
PACKAGE_ID=$(node -pe "require('./twa-manifest.json').packageId")

cat > "${ASSETLINKS_PATH}" <<EOF
[
  {
    "relation": ["delegate_permission/common.handle_all_urls"],
    "target": {
      "namespace": "android_app",
      "package_name": "${PACKAGE_ID}",
      "sha256_cert_fingerprints": ["${FINGERPRINT_COLON}"]
    }
  }
]
EOF
echo "     ${ASSETLINKS_PATH} 갱신 완료 — 이 파일을 web 앱에 재배포한 뒤에 Play Console 도메인 인증이 통과합니다."

echo "[2/3] @bubblewrap/cli로 프로젝트 초기화/동기화 중..."
if [[ ! -f "app/build.gradle" ]]; then
  npx @bubblewrap/cli init --manifest="./twa-manifest.json" --directory="."
else
  npx @bubblewrap/cli update
fi

echo "[3/3] .aab(Android App Bundle) 빌드 중..."
npx @bubblewrap/cli build \
  --skipPwaValidation \
  --password:"${KEYSTORE_PASSWORD}" \
  --keyPassword:"${KEY_PASSWORD}"

echo
echo "================================================================"
echo " 빌드 완료: ./app-release-bundle.aab"
echo " 다음 단계: Google Play Console > 프로덕션(또는 테스트) 트랙에 업로드"
echo "================================================================"
