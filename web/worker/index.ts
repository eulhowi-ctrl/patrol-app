/// <reference lib="webworker" />
// next-pwa가 자동 생성하는 서비스워커(public/sw.js)에 importScripts로 끼워 넣는
// 커스텀 워커 — push/notificationclick 이벤트만 추가한다 (precache/캐싱 로직은 건드리지 않음).
// web/pages/api/push/notify.ts가 보낸 payload를 받아 화면에 알림으로 띄운다.
export {}; // import/export가 없으면 전역 스크립트로 취급되어 tsconfig의 dom lib와 self 타입이 충돌함
declare const self: ServiceWorkerGlobalScope;

interface PushPayload {
  title: string;
  body: string;
  tag?: string;
}

self.addEventListener("push", (event: PushEvent) => {
  let payload: PushPayload = { title: "ARGUS", body: "새 알림이 있습니다." };
  try {
    if (event.data) payload = { ...payload, ...event.data.json() };
  } catch {
    // JSON이 아닌 payload면 기본 문구를 그대로 사용
  }

  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      tag: payload.tag,
      requireInteraction: true,
    })
  );
});

// 알림을 탭하면 이미 열려있는 ARGUS 탭으로 포커스하고, 없으면 새로 연다.
self.addEventListener("notificationclick", (event: NotificationEvent) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ("focus" in client) return client.focus();
      }
      return self.clients.openWindow?.("/");
    })
  );
});
