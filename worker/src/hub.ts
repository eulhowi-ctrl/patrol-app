import { DurableObject } from "cloudflare:workers";
import type { Env } from "./types";

// 사이트 1개 = Durable Object 1개. 이 사이트의 스테이션·모니터링 화면이 모두 여기에 WebSocket으로 붙는다.
//  - 스테이션 접속/해제 = 온라인 상태 (HTTP heartbeat 폴링이 필요 없음 → 서버 요청 수 절감)
//  - 이벤트 발생 시 모니터링 화면에 실시간 전달
//  - 라이브 보기: 모니터링 ↔ 스테이션 사이 신호(WebRTC)·사진 프레임 중계
// Hibernation API를 써서 연결만 유지하는 동안은 과금되는 실행 시간이 거의 없다.

interface Attach {
  role: "station" | "viewer";
  id: string; // stationId 또는 userId
  conn: string; // 소켓 고유 ID
}

const TO_STATION = new Set(["live-start", "live-stop", "offer", "answer", "ice", "rtc-up"]);
// 끊기는 중인 소켓에 보내면 예외가 나서 허브 전체가 멈출 수 있다 — 개별 실패는 무시
function safeSend(ws: WebSocket, text: string) {
  try {
    ws.send(text);
  } catch {
    /* 끊긴 소켓 */
  }
}

const TO_VIEWER = new Set(["offer", "answer", "ice", "frame", "boxes", "live-error"]);

export class SiteHub extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // 클라이언트 keep-alive: 깨우지 않고 자동 응답
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/broadcast") {
      this.toViewers(await req.text());
      return new Response("ok");
    }

    // 스테이션 등록이 삭제됨 — 해당 기기에 알리고 연결을 끊는다 (stationId 없으면 사이트 전체)
    if (url.pathname === "/kick") {
      const only = url.searchParams.get("stationId");
      for (const s of this.stationSockets()) {
        const a = s.deserializeAttachment() as Attach;
        if (only && a.id !== only) continue;
        try {
          s.send(JSON.stringify({ t: "removed" }));
          s.close(1000, "removed");
        } catch {
          /* 이미 끊김 */
        }
      }
      return new Response("ok");
    }

    if (req.headers.get("Upgrade") !== "websocket") {
      return new Response("WebSocket만 허용됩니다.", { status: 426 });
    }

    const role = url.searchParams.get("role") as Attach["role"] | null;
    const id = url.searchParams.get("id");
    if ((role !== "station" && role !== "viewer") || !id) {
      return new Response("잘못된 요청", { status: 400 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const conn = crypto.randomUUID().slice(0, 8);
    this.ctx.acceptWebSocket(server, [`${role}:${id}`, `c:${conn}`]);
    server.serializeAttachment({ role, id, conn } satisfies Attach);

    if (role === "station") {
      // 같은 스테이션의 이전 소켓(끊긴 줄 모르는 좀비)은 정리
      for (const old of this.ctx.getWebSockets(`station:${id}`)) {
        if (old !== server) {
          try {
            old.close(1000, "replaced");
          } catch {
            /* 이미 닫힘 */
          }
        }
      }
      await this.setOnline(id, true);
      this.toViewers(JSON.stringify({ t: "presence", stationId: id, online: true }));
    } else {
      server.send(
        JSON.stringify({ t: "hello", conn, online: this.onlineStations() })
      );
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (typeof message !== "string") return;
    const a = ws.deserializeAttachment() as Attach | null;
    if (!a) return;
    let msg: { t?: string; to?: string; [k: string]: unknown };
    try {
      msg = JSON.parse(message);
    } catch {
      return;
    }
    if (!msg.t || !msg.to) return;

    if (a.role === "viewer" && TO_STATION.has(msg.t)) {
      const out = JSON.stringify({ ...msg, from: a.conn });
      for (const s of this.ctx.getWebSockets(`station:${msg.to}`)) safeSend(s, out);
    } else if (a.role === "station" && TO_VIEWER.has(msg.t)) {
      const out = JSON.stringify({ ...msg, stationId: a.id });
      for (const v of this.ctx.getWebSockets(`c:${msg.to}`)) safeSend(v, out);
    }
  }

  async webSocketClose(ws: WebSocket) {
    await this.handleGone(ws);
  }

  async webSocketError(ws: WebSocket) {
    await this.handleGone(ws);
  }

  private async handleGone(ws: WebSocket) {
    const a = ws.deserializeAttachment() as Attach | null;
    if (!a) return;
    try {
      ws.close();
    } catch {
      /* 이미 닫힘 */
    }
    if (a.role === "station") {
      const stillOpen = this.ctx
        .getWebSockets(`station:${a.id}`)
        .some((s) => s !== ws && s.readyState === WebSocket.OPEN);
      if (!stillOpen) {
        await this.setOnline(a.id, false);
        this.toViewers(
          JSON.stringify({ t: "presence", stationId: a.id, online: false })
        );
      }
    } else {
      // 보던 사람이 사라지면 스테이션의 라이브 송출을 멈추게 한다
      const out = JSON.stringify({ t: "viewer-gone", from: a.conn });
      for (const s of this.stationSockets()) safeSend(s, out);
    }
  }

  private stationSockets(): WebSocket[] {
    return this.ctx.getWebSockets().filter((s) => {
      const a = s.deserializeAttachment() as Attach | null;
      return a?.role === "station" && s.readyState === WebSocket.OPEN;
    });
  }

  private onlineStations(): string[] {
    const ids = new Set<string>();
    for (const s of this.stationSockets()) {
      ids.add((s.deserializeAttachment() as Attach).id);
    }
    return [...ids];
  }

  private toViewers(text: string) {
    for (const s of this.ctx.getWebSockets()) {
      const a = s.deserializeAttachment() as Attach | null;
      if (a?.role === "viewer" && s.readyState === WebSocket.OPEN) {
        try {
          s.send(text);
        } catch {
          /* 끊긴 소켓 */
        }
      }
    }
  }

  private async setOnline(stationId: string, online: boolean) {
    const now = Math.floor(Date.now() / 1000);
    await this.env.DB.prepare(
      "UPDATE stations SET online = ?, last_seen = ? WHERE id = ?"
    )
      .bind(online ? 1 : 0, now, stationId)
      .run();
  }
}
