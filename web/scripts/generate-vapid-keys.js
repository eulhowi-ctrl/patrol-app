#!/usr/bin/env node
// 웹 푸시(Web Push) 알림 발송에 필요한 VAPID 키 쌍 생성.
// Oracle Cloud 계정 같은 외부 인프라 없이 이 저장소 안에서 바로 만들 수 있는 값이라
// 커맨드로 제공한다 — 배포할 서버마다 한 번씩 실행해서 고유한 키를 쓸 것
// (여러 배포가 같은 키를 공유하면 안 됨).
const webpush = require("web-push");

const { publicKey, privateKey } = webpush.generateVAPIDKeys();

console.log("아래 값을 web/.env 파일에 추가하세요 (기존 값이 있다면 교체):\n");
console.log(`NEXT_PUBLIC_VAPID_PUBLIC_KEY=${publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${privateKey}`);
