// 서버(Cloudflare Worker) 클라이언트 — 스테이션/모니터링 화면 공용

function resolveBase(): string {
  const env = (process.env.NEXT_PUBLIC_API_BASE ?? "").replace(/\/$/, "");
  if (env) return env;
  if (typeof window !== "undefined" && ["localhost", "127.0.0.1"].includes(location.hostname)) {
    return "http://127.0.0.1:8787"; // 로컬 개발: `cd worker && npm run dev`
  }
  return "";
}

export const API_BASE = resolveBase();
export const WS_BASE = API_BASE.replace(/^http/, "ws");

// ── 저장된 신원 (로그인 없이 기기별 임의 ID) ──
const USER_KEY = "argus-user-v1";
const STATION_KEY = "argus-station-v1";

export interface UserCreds {
  userId: string;
  userToken: string;
}

export interface StationCreds {
  stationId: string;
  stationToken: string;
  siteId: string;
  siteName: string;
  name: string;
}

function readJsonStorage<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeJsonStorage(key: string, value: unknown | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* 저장 불가 환경(시크릿 모드 등)은 무시 */
  }
}

export const loadStation = () => readJsonStorage<StationCreds>(STATION_KEY);
export const saveStation = (c: StationCreds | null) => writeJsonStorage(STATION_KEY, c);

export async function ensureUser(): Promise<UserCreds> {
  const saved = readJsonStorage<UserCreds>(USER_KEY);
  if (saved) return saved;
  const res = await fetch(`${API_BASE}/api/users`, { method: "POST" });
  if (!res.ok) throw new Error("서버에 연결할 수 없습니다.");
  const creds = (await res.json()) as UserCreds;
  writeJsonStorage(USER_KEY, creds);
  return creds;
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function call<T>(
  path: string,
  init: { method?: string; body?: unknown; user?: UserCreds; stationToken?: string } = {}
): Promise<T> {
  if (!API_BASE) throw new ApiError(0, "서버 주소가 설정되지 않았습니다. (NEXT_PUBLIC_API_BASE)");
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  if (init.user) {
    headers["x-user-id"] = init.user.userId;
    headers["x-user-token"] = init.user.userToken;
  }
  if (init.stationToken) headers["x-station-token"] = init.stationToken;
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method: init.method ?? "GET",
      headers,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
  } catch {
    throw new ApiError(0, "서버에 연결할 수 없습니다.");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string }).error ?? "요청 실패");
  return data as T;
}

// ── 모니터링(사용자) ──
export interface MeStation {
  id: string;
  name: string;
  online: boolean;
  lastSeen: number;
  lastEventAt: number;
  snapshotAt: number;
  subscribed: boolean;
}
export interface MeSite {
  id: string;
  name: string;
  inviteCode: string;
  canManage: boolean; // 소유자(또는 소유자 정보 없는 예전 사이트의 참여자)만 이름 변경·삭제 가능
  stations: MeStation[];
}
export interface Me {
  telegramLinked: boolean;
  limits: { maxStations: number; stationCount: number };
  sites: MeSite[];
}

export const getMe = (user: UserCreds) => call<Me>("/api/me", { user });
export const createSite = (user: UserCreds, name: string) =>
  call<{ site: { id: string; name: string; inviteCode: string } }>("/api/sites", {
    method: "POST",
    body: { name },
    user,
  });
export const joinSite = (user: UserCreds, inviteCode: string) =>
  call<{ site: { id: string; name: string } }>("/api/join", {
    method: "POST",
    body: { inviteCode },
    user,
  });
export const renameSite = (user: UserCreds, siteId: string, name: string) =>
  call<{ ok: true; name: string }>(`/api/sites/${siteId}`, { method: "PUT", body: { name }, user });
export const deleteSite = (user: UserCreds, siteId: string) =>
  call<{ ok: true; removedStations: number }>(`/api/sites/${siteId}`, { method: "DELETE", user });
// 모니터링 화면에서 스테이션 등록 삭제 (꺼진 기기·잘못 등록된 스테이션 정리)
export const removeStationAsUser = (user: UserCreds, stationId: string) =>
  call<{ ok: true }>(`/api/stations/${stationId}`, { method: "DELETE", user });
export const setSubscription = (user: UserCreds, stationId: string, on: boolean) =>
  call<{ ok: true }>("/api/subscriptions", {
    method: "PUT",
    body: { stationId, on },
    user,
  });
export const getTelegramLink = (user: UserCreds) =>
  call<{ url: string | null; token: string }>("/api/me/telegram-link", {
    method: "POST",
    user,
  });

export const snapshotUrl = (stationId: string, version: number) =>
  `${API_BASE}/api/stations/${stationId}/snapshot?v=${version}`;

export function viewerSocketUrl(user: UserCreds, siteId: string): string {
  const q = new URLSearchParams({
    role: "viewer",
    siteId,
    userId: user.userId,
    token: user.userToken,
  });
  return `${WS_BASE}/ws?${q}`;
}

// ── 스테이션 ──
export const registerStation = (inviteCode: string, name: string) =>
  call<StationCreds>("/api/stations", { method: "POST", body: { inviteCode, name } });

export const removeStation = (c: StationCreds) =>
  call<{ ok: true }>(`/api/stations/${c.stationId}`, {
    method: "DELETE",
    stationToken: c.stationToken,
  });

export const postEvent = (c: StationCreds, label: string, score: number, image: string) =>
  call<{ ok: true; alerted: boolean; eventId: number }>(`/api/stations/${c.stationId}/events`, {
    method: "POST",
    body: { label, score, image },
    stationToken: c.stationToken,
  });

export const putSnapshot = (c: StationCreds, image: string) =>
  call<{ ok: true }>(`/api/stations/${c.stationId}/snapshot`, {
    method: "PUT",
    body: { image },
    stationToken: c.stationToken,
  });

export function stationSocketUrl(c: StationCreds): string {
  const q = new URLSearchParams({ role: "station", stationId: c.stationId, token: c.stationToken });
  return `${WS_BASE}/ws?${q}`;
}
