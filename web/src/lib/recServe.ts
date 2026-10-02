import { getPart, listParts, readPart } from "./recStore";
import type { RecConfig } from "./recPolicy";

// 모니터링의 녹화 재생 요청에 응답해, 스테이션 폰의 조각을 잘게 나눠 서버 중계로 보낸다.
// 감시(추론)가 느려지지 않도록:
//  1) 속도 제한: 재생 속도의 3배 정도만 (토큰 버킷: 일정 속도로 채워지는 전송 허용량)
//  2) 흐름 제어: 받는 쪽이 확인(ack)한 만큼만 다음을 보냄 (최대 WINDOW개 미확인)
//  3) 추론 중이거나 소켓 송신 대기열이 차 있으면 그 틱은 쉬고 감시를 우선

const CHUNK_BYTES = 64 * 1024;
const WINDOW = 4;
const TICK_MS = 200;
const SPEED = 3; // 재생 속도 대비 전송 배수
const BURST_BYTES = 256 * 1024; // 시작 직후 바로 볼 수 있게 처음엔 몇 초치 먼저

type Send = (obj: unknown) => void;

interface Session {
  start: number;
  blob: Blob;
  total: number;
  seq: number; // 다음에 보낼 번호
  acked: number; // 받는 쪽이 확인한 마지막 번호
  tokens: number;
  last: number;
  timer: ReturnType<typeof setInterval>;
  busy: boolean;
}

function toBase64(blob: Blob): Promise<string> {
  // FileReader는 브라우저가 내부적으로 처리해 메인 스레드 부담이 작다
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",", 2)[1] ?? "");
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

export class RecServer {
  private sessions = new Map<string, Session>();

  constructor(
    private send: Send,
    private cfg: RecConfig,
    private canSend: () => boolean, // 추론 중 아님 + 소켓 송신 대기열 여유
    private currentStart: () => number | null
  ) {}

  get conns(): string[] {
    return [...this.sessions.keys()];
  }

  async list(conn: string) {
    const parts = await listParts();
    const cur = this.currentStart();
    this.send({
      t: "rec-index",
      to: conn,
      parts: parts.map((p) => ({ start: p.start, end: p.end, mime: p.mime, bytes: p.bytes, live: p.start === cur })),
      keepMs: this.cfg.keepMs,
      unitMs: this.cfg.unitMs,
      partMs: this.cfg.partMs,
      now: Date.now(),
    });
  }

  async get(conn: string, start: number) {
    this.stop(conn);
    const meta = await getPart(start);
    const blob = meta ? await readPart(start) : null;
    if (!meta || !blob || blob.size === 0) {
      this.send({ t: "rec-error", to: conn, start, message: "해당 시각의 녹화가 없습니다. (이미 지워졌을 수 있음)" });
      return;
    }
    const total = Math.ceil(blob.size / CHUNK_BYTES);
    const s: Session = {
      start,
      blob,
      total,
      seq: 0,
      acked: -1,
      tokens: BURST_BYTES,
      last: Date.now(),
      busy: false,
      timer: setInterval(() => void this.pump(conn), TICK_MS),
    };
    this.sessions.set(conn, s);
    this.send({ t: "rec-begin", to: conn, start, end: meta.end, mime: meta.mime, total, bytes: blob.size });
    void this.pump(conn);
  }

  ack(conn: string, start: number, seq: number) {
    const s = this.sessions.get(conn);
    if (s && s.start === start) s.acked = Math.max(s.acked, seq);
  }

  private async pump(conn: string) {
    const s = this.sessions.get(conn);
    if (!s || s.busy) return;
    const now = Date.now();
    const rate = (this.cfg.bitrate / 8) * SPEED; // bytes/s
    s.tokens = Math.min(BURST_BYTES, s.tokens + ((now - s.last) / 1000) * rate);
    s.last = now;
    if (!this.canSend()) return; // 감시 우선
    s.busy = true;
    try {
      while (s.seq < s.total && s.seq - s.acked <= WINDOW && s.tokens >= CHUNK_BYTES * 0.5 && this.canSend()) {
        const from = s.seq * CHUNK_BYTES;
        const piece = s.blob.slice(from, Math.min(s.blob.size, from + CHUNK_BYTES));
        const data = await toBase64(piece);
        if (this.sessions.get(conn) !== s) return; // 그 사이 취소됨
        this.send({ t: "rec-chunk", to: conn, start: s.start, seq: s.seq, total: s.total, data });
        s.tokens -= piece.size;
        s.seq++;
      }
      if (s.seq >= s.total && s.acked >= s.total - 1) {
        this.send({ t: "rec-end", to: conn, start: s.start });
        this.stop(conn);
      }
    } finally {
      s.busy = false;
    }
  }

  stop(conn: string) {
    const s = this.sessions.get(conn);
    if (!s) return;
    clearInterval(s.timer);
    this.sessions.delete(conn);
  }

  stopAll() {
    [...this.sessions.keys()].forEach((c) => this.stop(c));
  }
}
