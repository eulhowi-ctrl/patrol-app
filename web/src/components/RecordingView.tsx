import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getStationHistory, type HistoryEvent, type MeStation, type UserCreds } from "../lib/api";
import { findPart, mergeRanges } from "../lib/recPolicy";
import type { SiteMessage } from "./LiveView";

// 녹화 다시보기: 영상은 스테이션 폰에만 있다. 시각을 고르면 스테이션이 그 1분 조각을
// 서버 중계로 보내 주고, 여기서는 메모리에서만 재생한다(파일로 저장하지 않음).
// 24시간 막대: 회색 = 녹화된 구간, 빨간 점 = 위반 시각.

interface RecPart {
  start: number;
  end: number;
  mime: string;
  bytes: number;
  live: boolean;
}
interface RecIndex {
  parts: RecPart[];
  keepMs: number;
  now: number;
}

// 받는 중인 조각의 재생 상태
interface Playing {
  start: number;
  end: number;
  offset: number; // 조각 안에서 시작할 위치(초)
  mime: string;
  total: number;
  got: number;
  mse: { ms: MediaSource; sb: SourceBuffer | null; queue: Uint8Array[]; ended: boolean } | null;
  blobs: Uint8Array[]; // MSE를 못 쓰는 브라우저용: 다 받은 뒤 한 번에 재생
  seeked: boolean;
  url: string | null;
}

const fmt = (ms: number) =>
  new Date(ms).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
const fmtHM = (ms: number) => new Date(ms).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export default function RecordingView({
  siteId,
  station,
  user,
  send,
  subscribe,
}: {
  siteId: string;
  station: MeStation;
  user: UserCreds;
  send: (siteId: string, msg: unknown) => void;
  subscribe: (fn: (siteId: string, msg: SiteMessage) => void) => () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const playRef = useRef<Playing | null>(null);
  const indexRef = useRef<RecIndex | null>(null);
  const [index, setIndex] = useState<RecIndex | null>(null);
  const [events, setEvents] = useState<HistoryEvent[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [current, setCurrent] = useState<number | null>(null); // 지금 보고 있는 실제 시각(ms)
  const [timeInput, setTimeInput] = useState("");
  const [partStart, setPartStart] = useState<number | null>(null); // 지금 받는/재생하는 조각

  const toStation = useCallback((msg: Record<string, unknown>) => send(siteId, { ...msg, to: station.id }), [send, siteId, station.id]);

  // ── 재생기 정리 ──
  const resetPlayer = useCallback(() => {
    const p = playRef.current;
    if (p?.url) URL.revokeObjectURL(p.url);
    playRef.current = null;
    const v = videoRef.current;
    if (v) {
      v.removeAttribute("src");
      v.load();
    }
    setProgress(null);
  }, []);

  const requestPart = useCallback(
    (part: RecPart, offsetSec: number) => {
      resetPlayer();
      playRef.current = {
        start: part.start,
        end: part.end,
        offset: Math.max(0, offsetSec),
        mime: part.mime,
        total: 0,
        got: 0,
        mse: null,
        blobs: [],
        seeked: false,
        url: null,
      };
      setCurrent(part.start + Math.max(0, offsetSec) * 1000);
      setPartStart(part.start);
      setStatus("스테이션에서 받아오는 중…");
      toStation({ t: "rec-get", start: part.start });
    },
    [resetPlayer, toStation]
  );

  const playAt = useCallback(
    (t: number) => {
      const idx = indexRef.current;
      if (!idx) return;
      const part = findPart(idx.parts, t);
      if (!part) {
        // 가장 최근 녹화보다 뒤(막대 오른쪽 끝)를 누르면 최근 녹화의 마지막 몇 초부터
        const last = [...idx.parts].sort((a, b) => b.start - a.start)[0];
        if (!last) {
          setStatus("아직 저장된 녹화가 없습니다.");
          return;
        }
        requestPart(last, Math.max(0, (last.end - last.start) / 1000 - 5));
        return;
      }
      requestPart(part, (Math.max(t, part.start) - part.start) / 1000);
    },
    [requestPart]
  );

  // 받은 만큼 보이면 원하는 위치로 이동 후 재생
  const trySeek = useCallback(() => {
    const p = playRef.current;
    const v = videoRef.current;
    if (!p || !v || p.seeked) return;
    const b = v.buffered;
    const bufEnd = b.length ? b.end(b.length - 1) : 0;
    const full = p.mse?.ended || p.got >= p.total;
    if (bufEnd >= p.offset + 0.5 || (full && bufEnd > 0)) {
      p.seeked = true;
      v.currentTime = Math.min(p.offset, Math.max(0, bufEnd - 0.2));
      void v.play().catch(() => undefined);
      setStatus(null);
    }
  }, []);

  const pumpMse = useCallback(() => {
    const p = playRef.current;
    const m = p?.mse;
    if (!p || !m?.sb || m.sb.updating) return;
    const next = m.queue.shift();
    if (next) {
      m.sb.appendBuffer(next as BufferSource);
      return;
    }
    if (p.got >= p.total && !m.ended && m.ms.readyState === "open") {
      m.ended = true;
      try {
        m.ms.endOfStream();
      } catch {
        /* 이미 닫힘 */
      }
      trySeek();
    }
  }, [trySeek]);

  // ── 스테이션 메시지 처리 ──
  useEffect(() => {
    const off = subscribe((sid, msg) => {
      if (sid !== siteId || msg.stationId !== station.id) return;
      const p = playRef.current;

      if (msg.t === "rec-index") {
        const idx = { parts: msg.parts as RecPart[], keepMs: msg.keepMs as number, now: msg.now as number };
        indexRef.current = idx;
        setIndex(idx);
        if (idx.parts.length === 0) setStatus("아직 저장된 녹화가 없습니다. (스테이션 설정에서 녹화가 켜져 있는지 확인)");
      } else if (msg.t === "rec-error") {
        setStatus((msg.message as string) ?? "녹화를 불러올 수 없습니다.");
        setProgress(null);
      } else if (msg.t === "rec-begin" && p && msg.start === p.start) {
        p.total = msg.total as number;
        p.mime = msg.mime as string;
        p.end = msg.end as number;
        const v = videoRef.current;
        if (v && typeof MediaSource !== "undefined" && MediaSource.isTypeSupported(p.mime)) {
          // 받는 대로 바로 재생 (MSE: 브라우저에 영상 조각을 이어 넣는 기능)
          const ms = new MediaSource();
          p.mse = { ms, sb: null, queue: [], ended: false };
          p.url = URL.createObjectURL(ms);
          v.src = p.url;
          ms.addEventListener(
            "sourceopen",
            () => {
              if (playRef.current !== p || !p.mse) return;
              const sb = ms.addSourceBuffer(p.mime);
              sb.mode = "sequence";
              sb.addEventListener("updateend", () => {
                if (playRef.current !== p) return;
                trySeek();
                pumpMse();
              });
              p.mse.sb = sb;
              pumpMse();
            },
            { once: true }
          );
        }
      } else if (msg.t === "rec-chunk" && p && msg.start === p.start) {
        const bytes = b64ToBytes(msg.data as string);
        p.got = (msg.seq as number) + 1;
        setProgress(Math.round((p.got / Math.max(1, p.total)) * 100));
        if (p.mse) {
          p.mse.queue.push(bytes);
          pumpMse();
        } else {
          p.blobs.push(bytes);
        }
        toStation({ t: "rec-ack", start: p.start, seq: msg.seq });
      } else if (msg.t === "rec-end" && p && msg.start === p.start) {
        setProgress(null);
        if (p.mse) pumpMse();
        else {
          const v = videoRef.current;
          if (!v) return;
          p.url = URL.createObjectURL(new Blob(p.blobs as BlobPart[], { type: p.mime }));
          v.src = p.url;
          v.addEventListener(
            "loadeddata",
            () => {
              p.seeked = true;
              v.currentTime = p.offset;
              void v.play().catch(() => undefined);
              setStatus(null);
            },
            { once: true }
          );
        }
      }
    });
    return off;
  }, [subscribe, siteId, station.id, toStation, pumpMse, trySeek]);

  // ── 처음: 녹화 목록 + 위반 시각 ──
  const loadIndex = useCallback(() => {
    if (!station.online) {
      setStatus("스테이션이 꺼져 있어 녹화를 볼 수 없습니다. (녹화는 스테이션 폰에만 저장됨)");
      return;
    }
    setStatus(null);
    toStation({ t: "rec-list" });
    void getStationHistory(user, station.id, Math.floor(Date.now() / 1000) - 24 * 3600)
      .then((r) => setEvents(r.events))
      .catch(() => undefined);
  }, [station.online, station.id, toStation, user]);

  useEffect(() => {
    loadIndex();
    // 통신이 느려 목록 응답이 안 오면 두 번 더 요청, 그래도 없으면 안내
    const retries = [4000, 9000].map((ms) => setTimeout(() => !indexRef.current && station.online && toStation({ t: "rec-list" }), ms));
    const giveUp = setTimeout(() => {
      if (!indexRef.current && station.online) setStatus("스테이션 응답이 없습니다. 잠시 후 새로고침을 눌러 주세요.");
    }, 15000);
    return () => {
      retries.forEach(clearTimeout);
      clearTimeout(giveUp);
      toStation({ t: "rec-stop" });
      resetPlayer();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [station.id, station.online]);

  // 재생 위치 → 실제 시각, 조각이 끝나면 다음 조각 이어서
  const onTimeUpdate = () => {
    const p = playRef.current;
    const v = videoRef.current;
    if (p && v && p.seeked) setCurrent(p.start + v.currentTime * 1000);
  };
  const onEnded = () => {
    const p = playRef.current;
    const idx = indexRef.current;
    if (!p || !idx) return;
    const next = [...idx.parts].sort((a, b) => a.start - b.start).find((x) => x.start > p.start);
    if (next && next.start - p.end < 10_000) requestPart(next, 0);
    else setStatus(next ? "녹화가 끊긴 구간입니다. 막대에서 다음 시각을 고르세요." : "가장 최근 녹화까지 봤습니다.");
  };

  // ── 24시간 막대 ──
  const span = useMemo(() => {
    const now = index?.now ?? Date.now();
    return { from: now - (index?.keepMs ?? 24 * 3600_000), to: now };
  }, [index]);
  const pos = (t: number) => `${Math.min(100, Math.max(0, ((t - span.from) / (span.to - span.from)) * 100))}%`;
  const ranges = useMemo(() => mergeRanges(index?.parts ?? []), [index]);
  const onBar = (e: React.MouseEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    playAt(span.from + ((e.clientX - r.left) / r.width) * (span.to - span.from));
  };
  const ticks = useMemo(() => {
    const out: number[] = [];
    const step = 6 * 3600_000;
    for (let t = Math.ceil(span.from / step) * step; t <= span.to; t += step) out.push(t);
    return out;
  }, [span]);

  const goTime = () => {
    // "14:05" → 최근 24시간 안의 그 시각
    const [h, m] = timeInput.split(":").map(Number);
    if (Number.isNaN(h) || Number.isNaN(m)) return;
    const d = new Date(span.to);
    d.setHours(h, m, 0, 0);
    let t = d.getTime();
    if (t > span.to) t -= 24 * 3600_000;
    playAt(t);
  };

  const recentEvents = events.filter((e) => !e.falsePositive).slice(0, 20);

  return (
    <div className="rv-root">
      <video
        ref={videoRef}
        className="lv-video rv-video"
        data-part={partStart ?? ""}
        playsInline
        muted
        controls
        onTimeUpdate={onTimeUpdate}
        onEnded={onEnded}
      />
      <div className="rv-now">
        {current ? fmt(current) : "막대를 눌러 볼 시각을 고르세요"}
        {progress !== null && <span className="st-muted"> · 받는 중 {progress}%</span>}
      </div>
      {status && <p className="st-muted rv-status">{status}</p>}

      <div className="rv-bar" onClick={onBar} role="slider" aria-label="녹화 시각 선택" aria-valuenow={current ?? 0}>
        {ranges.map(([a, b]) => (
          <span key={a} className="rv-range" style={{ left: pos(a), width: `calc(${pos(b)} - ${pos(a)})` }} />
        ))}
        {events.map((e) => (
          <span
            key={`${e.at}-${e.label}`}
            className={`rv-ev ${e.falsePositive ? "fp" : ""}`}
            style={{ left: pos(e.at * 1000) }}
            title={`${e.labelKo} ${fmtHM(e.at * 1000)}`}
          />
        ))}
        {current && <span className="rv-cursor" style={{ left: pos(current) }} />}
      </div>
      <div className="rv-ticks">
        {ticks.map((t) => (
          <span key={t} style={{ left: pos(t) }}>
            {fmtHM(t)}
          </span>
        ))}
      </div>

      <div className="st-row rv-controls">
        <input className="st-input" type="time" value={timeInput} onChange={(e) => setTimeInput(e.target.value)} />
        <button className="st-btn" disabled={!timeInput || !index} onClick={goTime}>
          이 시각 보기
        </button>
        <button className="st-btn" onClick={loadIndex}>
          새로고침
        </button>
      </div>

      {recentEvents.length > 0 && (
        <div className="rv-events">
          <strong>최근 위반 (눌러서 10초 전부터 보기)</strong>
          {recentEvents.map((e) => (
            <button key={`${e.at}-${e.label}`} className="rv-event" onClick={() => playAt(e.at * 1000 - 10_000)}>
              <span className="rv-ev-dot" /> {fmtHM(e.at * 1000)} {e.labelKo}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
