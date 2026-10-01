// 브라우저 Web Push 구독/해제 + 고위험 이벤트 외부 알림 트리거.
// VAPID 키가 설정되지 않았거나 브라우저가 Push API를 지원하지 않으면(iOS는 홈 화면에
// 추가한 PWA에서만 지원) 조용히 비활성화된다 — 오프라인 저장/감지 같은 핵심 기능과는 무관.
import { HIGH_PRIORITY_LABELS, type DetectionLabel } from "./labels";

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const base64Safe = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64Safe);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

export function isPushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

export async function getPushSubscription(): Promise<PushSubscription | null> {
  if (!isPushSupported()) return null;
  const registration = await navigator.serviceWorker.ready;
  return registration.pushManager.getSubscription();
}

// 이 기기를 고위험 이벤트 외부 알림 수신 대상으로 등록한다 (관리자 기기에서 호출).
export async function subscribeToHighPriorityAlerts(): Promise<boolean> {
  if (!isPushSupported()) return false;
  const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  if (!publicKey) {
    console.warn("[push] NEXT_PUBLIC_VAPID_PUBLIC_KEY가 설정되지 않았습니다 (web/.env 확인).");
    return false;
  }

  const permission = await Notification.requestPermission();
  if (permission !== "granted") return false;

  const registration = await navigator.serviceWorker.ready;
  const subscription =
    (await registration.pushManager.getSubscription()) ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    }));

  await fetch("/api/push/subscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(subscription.toJSON()),
  });
  return true;
}

export async function unsubscribeFromHighPriorityAlerts(): Promise<void> {
  if (!isPushSupported()) return;
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  if (!subscription) return;

  const endpoint = subscription.endpoint;
  await subscription.unsubscribe();
  await fetch("/api/push/unsubscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ endpoint }),
  });
}

// 고위험 이벤트 감지 시 서버에 외부 알림 발송을 요청한다. 네트워크가 없거나 요청이
// 실패해도 그냥 무시한다 — 감지/저장이라는 핵심 플로우를 막아서는 안 되는 부가 기능.
export function notifyHighPriority(label: DetectionLabel): void {
  if (!HIGH_PRIORITY_LABELS.includes(label)) return;
  if (typeof navigator !== "undefined" && !navigator.onLine) return;

  void fetch("/api/push/notify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ label }),
  }).catch((err) => console.warn("[push] 알림 전송 요청 실패:", err));
}
