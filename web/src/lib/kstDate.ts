// 기기 타임존 설정과 무관하게 항상 한국 표준시(KST, UTC+9) 기준으로 날짜/시간을 해석한다.
// capturedAt은 new Date().toISOString()(UTC)로 저장되므로, 단순 slice(0,10)이나
// getHours()를 쓰면 기기가 UTC/다른 타임존이거나 자정 근처일 때 "오늘" 경계와
// 시간대 표시가 실제 한국 날짜와 어긋난다.
const KST_TIME_ZONE = "Asia/Seoul";

// en-CA 로케일은 Intl.DateTimeFormat 기본 옵션에서 YYYY-MM-DD 형식을 그대로 반환한다.
const dateKeyFormatter = new Intl.DateTimeFormat("en-CA", { timeZone: KST_TIME_ZONE });
const hourFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: KST_TIME_ZONE,
  hour: "numeric",
  hourCycle: "h23",
});

export function kstDateKey(date: Date | string = new Date()): string {
  const d = typeof date === "string" ? new Date(date) : date;
  return dateKeyFormatter.format(d);
}

export function kstHour(date: Date | string): number {
  const d = typeof date === "string" ? new Date(date) : date;
  const part = hourFormatter.formatToParts(d).find((p) => p.type === "hour");
  return part ? parseInt(part.value, 10) : d.getHours();
}
