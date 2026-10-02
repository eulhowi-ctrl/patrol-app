-- 개설자 이름: 참여자 화면에 "개설자: 이름"으로 표시. 기존 사이트는 NULL(개설자가 앱에서 등록)
ALTER TABLE sites ADD COLUMN owner_name TEXT;
