# ARGUS (AI Safety Patrol System)

> 🚧 **진행 중인 작업**: 헬멧(no_helmet) 인식률 개선 — 데이터 보강 + 재학습 진행 예정.
> 새 세션에서는 **[training/HELMET_IMPROVEMENT_PLAN.md](training/HELMET_IMPROVEMENT_PLAN.md)** 파일을
> 먼저 읽고 "진행 상태" 체크리스트의 다음 미완료 항목부터 이어서 진행할 것.

현장 안전 순찰을 위한 온디바이스 AI 기반 PWA(Progressive Web App)입니다.
스마트폰 카메라로 현장을 촬영하면 브라우저 내에서 실시간으로 위험 요소를 감지하고,
오프라인 환경(지하/터널 등 네트워크 단절 구간)에서도 감지 로그를 저장했다가
네트워크 복구 시 서버로 동기화합니다.

> **현재 상태**: 로드맵의 모든 단계(인프라 스크립트, PWA 프론트엔드, 오프라인 동기화,
> 테스트 하네스, TWA 빌드 자동화, 배포 스크립트)에 대한 코드가 작성되어 있고,
> `npm run build`(Next.js 프로덕션 빌드)와 테스트 하네스(`npm test`)가 로컬에서 실제로
> 통과하는 것까지 확인했습니다. 다만 아래 항목은 **사용자가 실제 계정/인프라를 보유해야만**
> 진행 가능하며, 이 저장소가 대신 발급하거나 실행할 수 없습니다 (자세한 내용은
> [사전 요구사항](#사전-요구사항) 참고):
> - 실제 Oracle Cloud 서버에서의 `setup-infrastructure.sh` 실행 및 실제 도메인 SSL 발급
> - 실제 화재/쓰러짐/보호구 클래스로 학습된 `.onnx` 모델 (현재 미포함)
> - Google Play 콘솔 업로드 및 실제 서명 키 발급

---

## 목차

- [개요](#개요)
- [아키텍처](#아키텍처)
- [오프라인 작동 구조](#오프라인-작동-구조)
- [감지 대상](#감지-대상)
- [기술 스택](#기술-스택)
- [로드맵 / 구현 단계](#로드맵--구현-단계)
- [사전 요구사항](#사전-요구사항)
- [디렉토리 구조](#디렉토리-구조)
- [앱 사용 방법](#앱-사용-방법)
- [로컬 개발 / 테스트 실행](#로컬-개발--테스트-실행)
- [배포 방법](#배포-방법)
- [문제 해결 (Troubleshooting)](#문제-해결-troubleshooting)

---

## 개요

건설/산업 현장의 직책자(관리감독자)가 순찰 중 스마트폰만으로 다음을 수행할 수 있도록 하는 것이 목표입니다.

- 보호구(안전모, 안전조끼, 보안경, 마스크) 미착용 감지
- 화재/불꽃 징후 감지
- 작업자 쓰러짐(Man-Down) 감지
- 복장 규정 위반(반팔/반바지 착용) 감지 — 사람 탐지 후 별도 분류기로 2단계 판정
- 위 이벤트를 스냅샷과 함께 자동 기록, 네트워크가 없는 구간에서도 로컬에 보관 후 복구 시 자동 업로드

> 위험지역(danger zone) 무단 진입은 클래스에서 제외했습니다 — 위험구역 경계는 현장마다
> 달라서 이미지만 보고 판별 가능한 시각적 속성이 아니기 때문입니다(사람 탐지 + 사용자가
> 앱에서 그린 구역과의 좌표 겹침 판정으로 별도 구현이 필요하며, 이 리포에는 미포함).
> 마찬가지로 안전그네·안전화 미착용은 공개 학습 데이터셋을 찾지 못해 이번 범위에서 제외했습니다.

## 아키텍처

```
┌─────────────────────────────┐        오프라인 시           ┌────────────────────┐
│   스마트폰 브라우저 (PWA)     │  ── IndexedDB 저장 ──▶       │   기기 로컬 저장소   │
│                              │                              └────────────────────┘
│  카메라 스트림 → Canvas       │                                       │
│         │                    │                              온라인 복귀 시 Bulk Sync
│         ▼                    │                                       ▼
│  Web Worker                  │        온라인 시           ┌────────────────────┐
│  (ONNX Runtime Web 추론)      │ ── HTTPS 전송 ──────────▶  │   백엔드 서버        │
└─────────────────────────────┘                             │ (Oracle Cloud Free  │
                                                              │  Tier, Docker)      │
                                                              └────────────────────┘
```

- **프론트엔드** (`web/src/components/CameraView.tsx`): `getUserMedia`로 카메라 스트림을 받아 Canvas에 그리고, 프레임을 Web Worker로 전달합니다.
- **추론** (`web/src/workers/detection.worker.ts`): 메인 스레드를 막지 않도록 전용 Web Worker에서 ONNX Runtime Web(wasm 백엔드)으로 YOLO 스타일 모델을 구동합니다. onnxruntime-web은 이미 압축된 산출물이라 webpack이 재파싱하면 오류가 나기 때문에(`npm run build`로 실제 재현/확인됨), ESM import 대신 `web/public/ort/`에 정적 복사한 뒤 `importScripts()`로 불러옵니다 (`web/scripts/copy-onnx-assets.js`, `postinstall` 훅).
- **오프라인 저장** (`web/src/lib/db.ts`): 감지 로그와 스냅샷(Base64 JPEG)을 IndexedDB에 저장합니다.
- **동기화** (`web/src/lib/sync.ts`): `navigator.onLine` 이벤트와 Background Sync API(지원 브라우저)로 네트워크 복구를 감지해 미동기화 레코드를 서버에 일괄(Bulk) 전송합니다.
- **백엔드** (`web/pages/api/detections.ts`): 최소 구현으로 수신 로그를 `web/data/detections.log.jsonl`에 append합니다. 운영 단계에서는 실제 DB(Postgres 등)로 교체가 필요합니다.
- **인프라** (`infra/`): Oracle Cloud Free Tier(1 vCPU, 1GB RAM) 인스턴스에 Docker Compose로 배포, Nginx + Let's Encrypt로 HTTPS를 강제합니다.
- **모바일 배포** (`android/`): TWA(Trusted Web Activity)로 패키징해 구글 플레이스토어에 배포합니다.

## 오프라인 작동 구조

1. 카메라 프레임이 500ms 간격으로 캡처되어 Web Worker에서 추론됩니다.
2. 위험 요소가 감지되면 스냅샷과 함께 즉시 **IndexedDB**(`patrol-app-db` / `detections` 스토어)에 `synced: false` 상태로 저장됩니다. 이 저장은 네트워크 상태와 무관하게 항상 먼저 일어납니다.
3. `navigator.onLine`이 `true`이면 즉시 서버로 전송을 시도합니다. 실패하거나 오프라인이면 레코드는 큐에 그대로 남습니다 (유실되지 않음).
4. 네트워크가 복구되면(`online` 이벤트, 또는 지원 브라우저의 Background Sync) 미동기화 레코드 전체를 `/api/detections`로 한 번에 전송하고, 성공한 레코드만 `synced: true`로 표시합니다.
5. 이 전체 흐름은 `test/test-harness.ts`에서 실제 IndexedDB 폴리필(fake-indexeddb)과 mock 서버 응답으로 검증됩니다.

## 감지 대상

| 항목 | 레이블 (`labels.ts`) | 설명 | 단계 |
|---|---|---|---|
| 안전모 미착용 | `no_helmet` | 헬멧 미착용 인원 감지 | 1단계 YOLO |
| 안전조끼 미착용 | `no_vest` | 조끼 미착용 인원 감지 | 1단계 YOLO |
| 보안경 미착용 | `no_safety_glasses` | 고글/보안경 미착용 인원 감지 | 1단계 YOLO |
| 마스크 미착용 | `no_mask` | 마스크 미착용/부적절 착용 감지 | 1단계 YOLO |
| 화재/불꽃 | `fire_smoke` | 카메라 스트림 내 화재 징후 (고위험, 즉시 알림) | 1단계 YOLO |
| 쓰러짐(Man-Down) | `man_down` | 쓰러진 자세의 인체 감지 (고위험, 즉시 알림) | 1단계 YOLO |
| 반팔/반바지 착용 | `sleeve`/`pants` (`ClothingAttributes`) | 긴팔·긴바지 규정 위반 감지 | 2단계 보조 분류기 (person 크롭 입력) |

미포함: 위험지역 진입(현장마다 다른 좌표라 시각적 학습 불가 — person 탐지 + 앱 내 구역
겹침 판정으로 별도 구현 필요), 안전그네·안전화 미착용(공개 데이터셋 없음).

## 기술 스택

- **프론트엔드**: Next.js(Pages Router) + TypeScript, `next-pwa`, `onnxruntime-web`(wasm), `idb`
- **저장소(클라이언트)**: IndexedDB
- **백엔드 인프라**: Docker, Docker Compose, Nginx, Certbot(Let's Encrypt)
- **배포 환경**: Oracle Cloud Free Tier (VM.Standard.E2.1.Micro, x86_64)
- **모바일 패키징**: `@bubblewrap/cli` (TWA)
- **테스트**: `ts-node` + `fake-indexeddb` 기반 CLI 파이프라인 테스트 하네스

## 로드맵 / 구현 단계

1. [x] 프로젝트 문서화 (README, .gitignore)
2. [x] 인프라 스크립트 (`infra/setup-infrastructure.sh`: swap, Docker, Nginx, SSL / `infra/docker-compose.yml`)
3. [x] PWA 프론트엔드 (카메라 + Web Worker + ONNX 추론) — `npm run build` 로컬 빌드 성공 확인
4. [x] 오프라인 동기화 (IndexedDB + Background Sync) — `web/src/lib/db.ts`, `sync.ts`
5. [x] 테스트 하네스 (`test/test-harness.ts`) — 실행 시 12건 assertion 전체 통과 확인
6. [x] TWA 빌드 자동화 (`android/twa-manifest.json`, `android/build-android.sh`, `assetlinks.json`)
7. [x] 배포 스크립트 (`scripts/deploy-and-push.sh`)

코드/스크립트는 모두 작성 및 로컬 검증되었지만, 실제 서버·도메인·Play 콘솔에서의 최종 배포 실행은
[사전 요구사항](#사전-요구사항)을 사용자가 준비한 뒤 [배포 방법](#배포-방법)에 따라 직접 수행해야 합니다.

## 사전 요구사항

실제 배포/운영을 위해서는 아래를 **사용자가 직접 준비**해야 합니다 (자동화 스크립트가 대신 발급/생성할 수 없는 항목):

- Oracle Cloud 계정 및 실행 중인 인스턴스 (SSH 접속 정보, Ubuntu x86_64)
- 소유한 도메인 (Let's Encrypt 인증서 발급 대상) — 인스턴스의 공인 IP로 A 레코드 설정 필요
- Google Play 개발자 계정 (등록비 $25) 및 JDK 17+/Android SDK (bubblewrap이 최초 실행 시 설치를 시도함)
- 학습된 객체 감지 모델 가중치 (`.onnx` 형식, `web/public/models/README.md`의 클래스 목록 참고)
- Node.js 18+ (로컬 개발/테스트/빌드용)

## 디렉토리 구조

```
ARGUS/
├── README.md
├── .gitignore
├── infra/
│   ├── setup-infrastructure.sh   # Swap, Docker, Nginx, Let's Encrypt 자동 설정
│   └── docker-compose.yml        # backend 컨테이너 정의 (build context: ../web)
├── web/                           # PWA 프론트엔드 + 최소 백엔드 API
│   ├── src/
│   │   ├── components/CameraView.tsx
│   │   ├── workers/detection.worker.ts
│   │   ├── lib/{labels,db,sync}.ts
│   │   └── styles/globals.css
│   ├── pages/
│   │   ├── index.tsx
│   │   ├── _app.tsx
│   │   └── api/{health,detections}.ts
│   ├── public/
│   │   ├── manifest.json
│   │   ├── models/README.md      # .onnx 모델 배치 위치 안내
│   │   ├── .well-known/assetlinks.json
│   │   └── ort/                  # postinstall이 복사하는 onnxruntime-web 정적 산출물 (gitignore)
│   ├── scripts/copy-onnx-assets.js
│   ├── Dockerfile
│   ├── .env.example
│   └── package.json
├── test/
│   ├── test-harness.ts           # 가상 카메라 감지 → IndexedDB → 동기화 파이프라인 검증
│   └── package.json
├── android/
│   ├── twa-manifest.json
│   └── build-android.sh
└── scripts/
    └── deploy-and-push.sh
```

## 앱 사용 방법

### 1. 기기 권한 허용

앱은 HTTPS 환경에서만 카메라 접근이 허용됩니다 (브라우저 보안 정책). 최초 접속 시:

1. 브라우저가 카메라 권한을 요청하면 **허용**을 선택합니다.
   - **Android Chrome**: 주소창 왼쪽 자물쇠 아이콘 → 권한 → 카메라 → 허용
   - **iOS Safari**: 설정 앱 > Safari > 카메라 → "확인" 또는 "허용"으로 설정
2. 권한을 실수로 거부한 경우, 브라우저의 사이트 설정에서 카메라 권한을 다시 허용한 뒤 새로고침합니다.
3. PWA를 홈 화면에 추가하면(공유 → "홈 화면에 추가") 네이티브 앱처럼 실행할 수 있습니다.

### 2. 순찰 화면 사용

1. 앱 실행 시 상단 상태 바에 온라인/오프라인 상태, 모델 로딩 상태, 동기화 대기 건수가 표시됩니다.
2. 카메라를 현장 방향으로 향하면 자동으로 0.5초 간격 추론이 시작되고, 감지된 항목이 화면 하단에 나열됩니다.
3. 화재/불꽃, 쓰러짐 같은 고위험 이벤트는 감지 즉시 별도로 표시됩니다.
4. 지하/터널 등 네트워크가 없는 구간에서도 감지 기록은 계속 저장되며, 별도 조작 없이 네트워크 복구 시 자동 업로드됩니다.

## 로컬 개발 / 테스트 실행

```bash
# 1) 프론트엔드 의존성 설치 (최초 1회, onnxruntime-web 정적 파일 자동 복사됨)
cd web
npm install
cp .env.example .env

# 2) 개발 서버 실행 (HTTPS가 아니므로 카메라 접근은 localhost에서만 예외적으로 허용됨)
npm run dev

# 3) 테스트 하네스 실행 (브라우저 없이 CLI에서 파이프라인 검증)
cd ../test
npm install
npm test

# 4) 프로덕션 빌드 검증
cd ../web
npm run build
```

## 배포 방법

```bash
# 1) 서버 인프라 구성 (Oracle Cloud 인스턴스에서, root 권한)
sudo DOMAIN=patrol.example.com EMAIL=you@example.com bash infra/setup-infrastructure.sh

# 2) 저장소를 서버에 clone 후 컨테이너 기동
git clone <YOUR_REPO_URL> /opt/patrol-app
cd /opt/patrol-app/infra
docker compose up -d --build

# 3) 안드로이드 TWA 빌드 (로컬 PC, JDK/Android SDK 필요)
cd android
# twa-manifest.json의 REPLACE_WITH_YOUR_DOMAIN을 실제 도메인으로 교체한 뒤
./build-android.sh

# 4) 테스트 통과 시에만 GitHub에 커밋/푸시
GITHUB_REPO_URL=https://github.com/USER/REPO.git \
GIT_USER_NAME=your-name \
GIT_USER_EMAIL=you@example.com \
GITHUB_PAT=ghp_xxx \
bash scripts/deploy-and-push.sh
```

## 문제 해결 (Troubleshooting)

| 증상 | 원인 | 해결 방법 |
|---|---|---|
| 카메라 화면이 검은색이거나 권한 팝업이 안 뜸 | HTTP(비보안) 환경에서 `getUserMedia` 호출 | HTTPS로 접속 (localhost는 예외). `infra/setup-infrastructure.sh`로 Let's Encrypt 인증서를 먼저 발급 |
| `next build` 시 onnxruntime-web 관련 `Syntax Error` | webpack이 이미 압축된 onnxruntime-web 산출물을 다시 파싱하려다 발생 (실제로 재현/수정됨) | `web/src/workers/detection.worker.ts`처럼 ESM import 대신 `importScripts()` + `public/ort/` 정적 파일 방식을 사용해야 함 |
| 모델 추론이 항상 아무것도 감지하지 못함 | `web/public/models/detector.onnx`가 없거나, 모델의 클래스 순서가 `labels.ts`의 `DETECTION_LABELS`와 다름 | 모델 파일 배치 여부 확인, export 시 클래스 순서를 4개 레이블과 동일하게 맞춤 |
| Oracle 인스턴스에서 `docker compose up` 중 프로세스가 죽음(OOM) | 1GB RAM 한계 초과 | `setup-infrastructure.sh`가 생성한 2GB swap이 활성화되어 있는지 `swapon --show`로 확인 |
| Play Console에서 "도메인 소유권 확인 실패" | `assetlinks.json`의 지문(fingerprint)이 실제 서명 키와 불일치 | `android/build-android.sh` 실행 후 갱신된 `web/public/.well-known/assetlinks.json`을 서버에 재배포 |
| 오프라인에서 저장한 로그가 온라인 전환 후에도 안 올라감 | Background Sync 미지원 브라우저(iOS Safari 등) | `sync.ts`는 `online` 이벤트로도 폴백 동작하므로 앱을 다시 포그라운드로 가져오면 동기화됨 |
| `npm test` 실행 시 `fake-indexeddb`를 찾을 수 없음 | `test/` 디렉토리에 별도 `node_modules` 미설치 | `cd test && npm install` 먼저 실행 |

---

## 라이선스

내부 프로젝트 — 별도 명시 전까지 라이선스 미지정.
