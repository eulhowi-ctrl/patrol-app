-- 보안코드: 모니터링 참여용 (초대코드는 스테이션 등록 전용으로 분리)
ALTER TABLE sites ADD COLUMN view_code TEXT;
-- 기존 사이트에 8자리 코드 부여 (hex라 0/O·1/I 혼동 글자 중 O·I는 없음)
UPDATE sites SET view_code = upper(hex(randomblob(4))) WHERE view_code IS NULL;
CREATE UNIQUE INDEX idx_sites_view_code ON sites(view_code);
