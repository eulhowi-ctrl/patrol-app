import { partsToDelete, partsToFree, type RecConfig } from "./recPolicy";
import { appendChunk, closeDangling, deleteParts, finishPart, listParts } from "./recStore";

// 스테이션 상시 녹화기.
// 감시용 카메라 스트림을 복제해 360p·저비트레이트로 녹화하고(감시 추론과 별개),
// partMs마다 녹화기를 새로 시작해 1분짜리 독립 재생 가능한 조각으로 저장한다.
// 1분마다 보관 규칙(24시간·5분 묶음)과 저장 공간을 점검해 오래된 것부터 지운다.

const MIME_CANDIDATES = ["video/webm;codecs=vp8", "video/webm;codecs=vp9", "video/webm", "video/mp4"];

export function pickMime(): string | null {
  if (typeof MediaRecorder === "undefined") return null;
  return MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m)) ?? null;
}

export interface RecStatus {
  recording: boolean;
  bytes: number; // 저장된 총량
  oldest: number | null;
  error: string | null;
}

export class StationRecorder {
  private track: MediaStreamTrack | null = null;
  private rec: MediaRecorder | null = null;
  private rotateTimer: ReturnType<typeof setTimeout> | null = null;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private mime: string;
  // 현재 녹화 중인 조각 (재생 요청 시 "아직 녹화 중" 판단용)
  currentStart: number | null = null;

  constructor(
    private stream: MediaStream,
    private cfg: RecConfig,
    private onStatus: (s: RecStatus) => void
  ) {
    this.mime = pickMime() ?? "";
  }

  async start() {
    if (!this.mime) {
      this.onStatus({ recording: false, bytes: 0, oldest: null, error: "이 기기 브라우저는 녹화를 지원하지 않습니다." });
      return;
    }
    // 브라우저가 저장소를 임의로 비우지 않도록 요청 (거절돼도 녹화는 진행)
    void navigator.storage?.persist?.().catch(() => false);
    await closeDangling();

    const src = this.stream.getVideoTracks()[0];
    if (!src) return;
    // 감시용 원본(720p)은 그대로 두고, 복제본만 360p·15fps로 낮춰 녹화 (인코딩 부담·용량 절감)
    this.track = src.clone();
    await this.track.applyConstraints({ width: 640, height: 360, frameRate: 15 }).catch(() => undefined);
    this.startPart();
    await this.sweep();
    this.sweepTimer = setInterval(() => void this.sweep(), 60_000);
  }

  private startPart() {
    if (this.stopped || !this.track) return;
    const start = Date.now();
    let idx = 0;
    let rec: MediaRecorder;
    try {
      rec = new MediaRecorder(new MediaStream([this.track]), {
        mimeType: this.mime,
        videoBitsPerSecond: this.cfg.bitrate,
      });
    } catch (e) {
      this.onStatus({ recording: false, bytes: 0, oldest: null, error: `녹화 시작 실패: ${e instanceof Error ? e.message : e}` });
      return;
    }
    this.rec = rec;
    this.currentStart = start;
    rec.ondataavailable = (e) => {
      if (e.data.size > 0) void appendChunk(start, idx++, e.data, this.mime, Date.now()).catch((err) => this.fail(err));
    };
    rec.onstop = () => {
      // 마지막 데이터 저장이 끝난 뒤 완료 표시
      setTimeout(() => void finishPart(start), 300);
    };
    rec.start(this.cfg.timesliceMs);
    this.rotateTimer = setTimeout(() => {
      // 새 조각 먼저 시작 후 이전 것 종료 → 끊김 최소화
      const old = this.rec;
      this.startPart();
      if (old && old.state !== "inactive") old.stop();
    }, this.cfg.partMs);
  }

  private fail(err: unknown) {
    // 저장 공간 부족 등: 오래된 것부터 지우고 계속 녹화
    console.warn("[rec] 저장 실패", err);
    void this.sweep(true);
  }

  // 보관 규칙 + 저장 공간 점검
  async sweep(force = false) {
    try {
      let parts = await listParts();
      const old = partsToDelete(parts, Date.now(), this.cfg);
      await deleteParts(old);
      parts = parts.filter((p) => !old.includes(p.start));

      const est = await navigator.storage?.estimate?.().catch(() => undefined);
      if (est?.quota && est.usage !== undefined) {
        const limit = est.quota * 0.85;
        if (force || est.usage > limit) {
          const free = partsToFree(parts, est.usage, est.quota * 0.7, this.cfg.unitMs);
          await deleteParts(free);
          parts = parts.filter((p) => !free.includes(p.start));
        }
      }
      this.onStatus({
        recording: !this.stopped && !!this.rec,
        bytes: parts.reduce((n, p) => n + p.bytes, 0),
        oldest: parts[0]?.start ?? null,
        error: null,
      });
    } catch (e) {
      console.warn("[rec] 정리 실패", e);
    }
  }

  stop() {
    this.stopped = true;
    if (this.rotateTimer) clearTimeout(this.rotateTimer);
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    if (this.rec && this.rec.state !== "inactive") this.rec.stop();
    this.rec = null;
    this.currentStart = null;
    this.track?.stop();
    this.track = null;
  }
}
