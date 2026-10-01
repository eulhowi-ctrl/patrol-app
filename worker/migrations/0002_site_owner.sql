-- 사이트 소유자: 이름 변경·삭제 권한. 기존 사이트는 NULL(참여자 누구나 관리 가능)
ALTER TABLE sites ADD COLUMN owner_id TEXT;
