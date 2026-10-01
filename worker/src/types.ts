export interface Env {
  DB: D1Database;
  HUB: DurableObjectNamespace;
  MAX_STATIONS: string;
  MAX_SITES: string;
  BOT_USERNAME: string;
  BOT_TOKEN?: string;
  WEBHOOK_SECRET?: string;
  TELEGRAM_API_BASE?: string; // 테스트용 모킹 서버 주소
}
