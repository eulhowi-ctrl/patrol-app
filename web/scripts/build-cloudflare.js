#!/usr/bin/env node
/**
 * Cloudflare Pages용 정적 export 빌드.
 *
 * Next.js의 output:'export'는 pages/api 라우트가 하나라도 있으면 빌드 자체가
 * 실패한다(서버 코드라 정적 export와 양립 불가). API 라우트(web/pages/api/*)는
 * 로컬 파일시스템에 쓰는 방식이라 어차피 Cloudflare 서버리스에서 그대로 못
 * 쓰므로, 빌드 동안만 잠시 다른 폴더로 옮겼다가 끝나면 원복한다.
 */
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const API_DIR = path.join(__dirname, "..", "pages", "api");
const BACKUP_DIR = path.join(__dirname, "..", ".api-backup-tmp");

function moveOut() {
  if (fs.existsSync(API_DIR)) {
    fs.renameSync(API_DIR, BACKUP_DIR);
  }
}

function restore() {
  if (fs.existsSync(BACKUP_DIR)) {
    fs.renameSync(BACKUP_DIR, API_DIR);
  }
}

moveOut();
try {
  execSync("npx next build", {
    stdio: "inherit",
    env: { ...process.env, CF_PAGES_BUILD: "1" },
  });
} finally {
  restore();
}
