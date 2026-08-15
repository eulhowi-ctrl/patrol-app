# 직책자 순찰앱 (Safety Patrol App)

현장 안전 순찰을 위한 온디바이스 AI 기반 PWA(Progressive Web App)입니다.
스마트폰 카메라로 현장을 촬영하면 브라우저 내에서 실시간으로 위험 요소를 감지하고,
오프라인 환경(지하/터널 등 네트워크 단절 구간)에서도 감지 로그를 저장했다가
네트워크 복구 시 서버로 동기화합니다.

> **현재 상태**: 초기 설계/계획 단계입니다. 이 문서는 목표 아키텍처와 로드맵을 기술하며,
> 각 컴포넌트는 순차적으로 구현됩니다. 아직 구현되지 않은 항목은 "예정"으로 표시했습니다.

---

## 목차

- [개요](#개요)
- [아키텍처](#아키텍처)
- [감지 대상](#감지-대상)
- [기술 스택](#기술-스택)
- [로드맵 / 구현 단계](#로드맵--구현-단계)
- [사전 요구사항](#사전-요구사항)
- [디렉토리 구조](#디렉토리-구조-예정)
- [문제 해결 (Troubleshooting)](#문제-해결-troubleshooting)

---

## 개요

건설/산업 현장의 직책자(관리감독자)가 순찰 중 스마트폰만으로 다음을 수행할 수 있도록 하는 것이 목표입니다.

- 보호구(안전모, 안전조끼) 미착용 감지
- 위험지역(추락/협착 위험 구역) 무단 진입 감지
- 화재/불꽃 징후 감지
- 작업자 쓰러짐(Man-Down) 감지
- 위 이벤트를 스냅샷과 함께 자동 기록, 네트워크가 없는 구간에서도 로컬에 보관 후 복구 시 자동 업로드

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

- **프론트엔드**: 카메라 스트림을 Canvas에 바인딩하고, 메인 스레드 차단을 막기 위해 Web Worker 내부에서 온디바이스 추론(ONNX Runtime Web)을 수행합니다. (예정)
- **오프라인 저장**: 감지 로그와 스냅샷(Base64)을 IndexedDB에 저장하고, `navigator.onLine` / Background Sync로 네트워크 복구를 감지해 서버로 일괄 전송합니다. (예정)
- **백엔드**: Oracle Cloud Free Tier(1 vCPU, 1GB RAM) 인스턴스에 Docker Compose로 구동, Nginx + Let's Encrypt로 HTTPS를 강제합니다. (예정)
- **배포**: TWA(Trusted Web Activity)로 패키징해 구글 플레이스토어에 배포합니다. (예정)

## 감지 대상

| 항목 | 설명 | 상태 |
|---|---|---|
| 보호구 미착용 | 안전모/안전조끼 미착용 인원 감지 | 예정 |
| 위험지역 진입 | 추락/협착 위험 구역 무단 진입 | 예정 |
| 화재/불꽃 | 카메라 스트림 내 화재 징후 | 예정 |
| 쓰러짐(Man-Down) | 쓰러진 자세의 인체 감지 | 예정 |

## 기술 스택

- **프론트엔드**: React / Next.js, TypeScript, ONNX Runtime Web, YOLOv8/v10 Nano(양자화)
- **저장소(클라이언트)**: IndexedDB
- **백엔드 인프라**: Docker, Docker Compose, Nginx, Certbot(Let's Encrypt)
- **배포 환경**: Oracle Cloud Free Tier (VM.Standard.E2.1.Micro, x86_64)
- **모바일 패키징**: @bubblewrap/cli (TWA)

## 로드맵 / 구현 단계

1. [x] 프로젝트 문서화 (README, .gitignore) — 이 커밋
2. [ ] 인프라 스크립트 (`setup-infrastructure.sh`: swap, Docker, Nginx, SSL)
3. [ ] PWA 프론트엔드 (카메라 + Web Worker + ONNX 추론)
4. [ ] 오프라인 동기화 (IndexedDB + Background Sync)
5. [ ] 테스트 하네스 (`test-harness.ts`: 가상 카메라 입력 → 파이프라인 검증)
6. [ ] TWA 빌드 자동화 (`twa-manifest.json`, `build-android.sh`, `assetlinks.json`)
7. [ ] 배포 스크립트 (`deploy-and-push.sh`)

각 단계는 실제 실행 가능한 코드로 구현되며, 완료된 항목만 체크됩니다.

## 사전 요구사항

실제 배포/운영을 위해서는 아래를 **사용자가 직접 준비**해야 합니다 (자동화 스크립트가 대신 발급/생성할 수 없는 항목):

- Oracle Cloud 계정 및 실행 중인 인스턴스 (SSH 접속 정보)
- 소유한 도메인 (Let's Encrypt 인증서 발급 대상)
- Google Play 개발자 계정 (등록비 $25, 앱 서명 키)
- 학습된 객체 감지 모델 가중치 (보호구/위험지역/화재/쓰러짐 클래스 포함, `.onnx` 형식)

## 디렉토리 구조 (예정)

```
직책자 순찰앱/
├── README.md
├── .gitignore
├── infra/
│   ├── setup-infrastructure.sh
│   ├── docker-compose.yml
│   └── nginx/
│       └── nginx.conf
├── web/                      # PWA 프론트엔드
│   ├── src/
│   ├── public/
│   │   └── .well-known/
│   │       └── assetlinks.json
│   └── package.json
├── test/
│   └── test-harness.ts
├── android/
│   ├── twa-manifest.json
│   └── build-android.sh
└── scripts/
    └── deploy-and-push.sh
```

## 문제 해결 (Troubleshooting)

이 섹션은 각 컴포넌트가 구현된 이후, 실제로 발생 가능한 이슈를 기준으로 채워집니다.
(예: 카메라 권한 거부, HTTPS 미적용 시 getUserMedia 차단, Oracle 인스턴스 OOM 등)

---

## 라이선스

내부 프로젝트 — 별도 명시 전까지 라이선스 미지정.
