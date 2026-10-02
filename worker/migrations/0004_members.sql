-- 참여자 관리: 개설자가 누가 들어왔는지 알아보고 내보낼 수 있게
ALTER TABLE user_sites ADD COLUMN joined_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE user_sites ADD COLUMN nickname TEXT;
