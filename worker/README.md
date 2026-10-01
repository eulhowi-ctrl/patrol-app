# ARGUS API (Cloudflare Worker)

스테이션 등록·구독·중복 알림 방지·Telegram 알림·실시간 허브를 담당하는 서버입니다.
영상은 서버로 오지 않습니다 (감지는 각 기기 안에서 수행). 서버에는 위반 시점 사진 1장과 접속 상태만 옵니다.

| 구성 | 역할 |
|---|---|
| Worker (`src/index.ts`) | REST API, Telegram 웹훅, 알림 발송 |
| D1 (`migrations/`) | 사이트·스테이션·구독·이벤트 |
| Durable Object `SiteHub` (`src/hub.ts`) | 사이트별 WebSocket 허브 (접속 상태, 실시간 이벤트, 라이브 중계) |

## 로컬 개발

```bash
cd worker
npm install
npm run migrate:local     # 로컬 D1 생성
npm run dev               # http://127.0.0.1:8787  (.dev.vars: 봇 토큰 등은 테스트용 값)
npm test                  # 다른 터미널에서 — 서버 E2E (Telegram은 모킹)
node test/alerts.test.mjs # 중복 방지 단계 단위 테스트
```

## 배포 (최초 1회)

```bash
cd worker
npx wrangler login
npx wrangler d1 create argus          # 출력된 database_id를 wrangler.toml에 붙여넣기
npm run migrate:remote
npx wrangler secret put BOT_TOKEN       # BotFather가 준 토큰
npx wrangler secret put WEBHOOK_SECRET  # 아무 긴 랜덤 문자열
# wrangler.toml의 BOT_USERNAME에 봇 사용자명(@ 제외) 입력
npm run deploy                          # 출력되는 https://argus-api.<계정>.workers.dev 주소를 기록

# Telegram이 이 서버로 업데이트를 보내도록 웹훅 등록
BOT_TOKEN=... WEBHOOK_SECRET=... API_URL=https://argus-api.<계정>.workers.dev node scripts/set-webhook.mjs
```

프론트(Cloudflare Pages)에는 빌드 환경변수 `NEXT_PUBLIC_API_BASE=https://argus-api.<계정>.workers.dev` 를 설정합니다.

## 용량 (무료 플랜 기준)

- 스테이션 상한은 `MAX_STATIONS`(기본 30)로 서버가 강제합니다.
- 서버 요청은 위반 보고와 사진 갱신(10분)뿐이고 접속 상태는 WebSocket이라 폴링 요청이 없습니다.
- 스테이션당 하루 약 150~400건 → 30대여도 무료 한도(Workers 10만/일, D1 쓰기 10만행/일) 안입니다.
- 한도를 넘으면 D1 쿼리가 실패하므로(2026-09-01부터 강제) 대수를 늘릴 땐 Workers 유료 플랜이 필요합니다.
