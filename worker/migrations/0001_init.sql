-- 사이트: 발전소/현장 단위. invite_code로 스테이션 등록·구독 참여
CREATE TABLE sites (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  invite_code TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

-- 스테이션: 현장에 거치된 감시 기기 (token은 SHA-256 해시로 저장)
CREATE TABLE stations (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  online INTEGER NOT NULL DEFAULT 0,
  last_seen INTEGER NOT NULL DEFAULT 0,
  last_event_at INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_stations_site ON stations(site_id);

-- 마지막 감지 사진 (분할화면 표시용). 스테이션당 1행
CREATE TABLE station_last (
  station_id TEXT PRIMARY KEY,
  image TEXT NOT NULL,
  at INTEGER NOT NULL
);

-- 사용자: 기기별 임의 ID (로그인 없음). Telegram 연결이 곧 본인 확인
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  telegram_chat_id TEXT,
  link_token TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_users_link ON users(link_token);

-- 사용자가 초대코드로 참여한 사이트
CREATE TABLE user_sites (
  user_id TEXT NOT NULL,
  site_id TEXT NOT NULL,
  PRIMARY KEY (user_id, site_id)
);

-- 알림 받을 스테이션 구독 (개인 DM)
CREATE TABLE subscriptions (
  user_id TEXT NOT NULL,
  station_id TEXT NOT NULL,
  PRIMARY KEY (user_id, station_id)
);
CREATE INDEX idx_sub_station ON subscriptions(station_id);

-- 사이트 단위 Telegram 그룹 연결 (분당 20건 제한 때문에 창 단위로 묶음 처리)
CREATE TABLE group_links (
  chat_id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  window_start INTEGER NOT NULL DEFAULT 0,
  window_count INTEGER NOT NULL DEFAULT 0,
  suppressed INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_group_site ON group_links(site_id);

-- 위반 이벤트 기록 (3일 보관)
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  station_id TEXT NOT NULL,
  label TEXT NOT NULL,
  score REAL NOT NULL DEFAULT 0,
  at INTEGER NOT NULL,
  alerted INTEGER NOT NULL DEFAULT 0,
  false_positive INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_events_station_at ON events(station_id, at);

-- 중복 알림 방지 상태: (스테이션, 위반유형)별
CREATE TABLE alert_state (
  station_id TEXT NOT NULL,
  label TEXT NOT NULL,
  last_event_at INTEGER NOT NULL DEFAULT 0,
  last_sent_at INTEGER NOT NULL DEFAULT 0,
  level INTEGER NOT NULL DEFAULT 0,
  muted_until INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (station_id, label)
);
