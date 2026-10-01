import { useEffect, useRef, useState } from "react";
import type { MeStation } from "../lib/api";

// 칸을 눌렀을 때의 라이브 보기.
//  1) 접속 즉시 스테이션이 1초 간격 사진을 보내 바로 화면이 뜬다.
//  2) 동시에 WebRTC 영상 연결을 시도하고, 성공하면 영상으로 전환한다.
//     5G 통신망은 직접 연결이 막히는 경우가 있어, 실패하면 1번 사진 방식이 그대로 유지된다.

export type SiteMessage = { t: string; [k: string]: unknown };

const ICE_SERVERS: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];
const NO_FRAME_MS = 10000;

export default function LiveView({
  siteId,
  station,
  send,
  subscribe,
  onClose,
}: {
  siteId: string;
  station: MeStation;
  send: (siteId: string, msg: unknown) => void;
  subscribe: (fn: (siteId: string, msg: SiteMessage) => void) => () => void;
  onClose: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [frame, setFrame] = useState<string | null>(null);
  const [mode, setMode] = useState<"connecting" | "photo" | "video">("connecting");
  const [message, setMessage] = useState<string | null>(null);
  const lastFrameAt = useRef(0);

  useEffect(() => {
    if (!station.online) return;
    let pc: RTCPeerConnection | null = null;
    const pendingIce: RTCIceCandidateInit[] = [];

    const off = subscribe(async (sid, msg) => {
      if (sid !== siteId || msg.stationId !== station.id) return;

      if (msg.t === "frame") {
        lastFrameAt.current = Date.now();
        setFrame(`data:image/jpeg;base64,${msg.data as string}`);
        setMode((m) => (m === "video" ? m : "photo"));
        setMessage(null);
      } else if (msg.t === "live-error") {
        setMessage((msg.message as string) ?? "라이브를 시작할 수 없습니다.");
      } else if (msg.t === "offer") {
        pc?.close();
        pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
        pc.onicecandidate = (e) =>
          e.candidate && send(siteId, { t: "ice", to: station.id, candidate: e.candidate.toJSON() });
        pc.ontrack = (e) => {
          const v = videoRef.current;
          if (!v) return;
          v.srcObject = e.streams[0];
          void v.play().catch(() => undefined);
        };
        try {
          await pc.setRemoteDescription({ type: "offer", sdp: msg.sdp as string });
          for (const c of pendingIce.splice(0)) await pc.addIceCandidate(c);
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          send(siteId, { t: "answer", to: station.id, sdp: answer.sdp });
        } catch {
          /* 영상 연결 실패 — 사진 방식 유지 */
        }
      } else if (msg.t === "ice" && msg.candidate) {
        const cand = msg.candidate as RTCIceCandidateInit;
        if (pc?.remoteDescription) await pc.addIceCandidate(cand).catch(() => undefined);
        else pendingIce.push(cand);
      }
    });

    send(siteId, { t: "live-start", to: station.id, rtc: true });

    // 영상이 실제로 재생되면 스테이션의 사진 전송을 멈추게 한다
    const v = videoRef.current;
    const onPlaying = () => {
      setMode("video");
      send(siteId, { t: "rtc-up", to: station.id });
    };
    v?.addEventListener("playing", onPlaying);

    const watchdog = setInterval(() => {
      if (lastFrameAt.current && Date.now() - lastFrameAt.current > NO_FRAME_MS && mode !== "video") {
        setMessage("스테이션 응답이 없습니다.");
      }
    }, 2000);

    return () => {
      clearInterval(watchdog);
      v?.removeEventListener("playing", onPlaying);
      send(siteId, { t: "live-stop", to: station.id });
      pc?.close();
      off();
    };
    // 스테이션이 바뀌지 않는 동안 한 번만 시작
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteId, station.id, station.online]);

  return (
    <div className="lv-root" onClick={onClose}>
      <div className="lv-head" onClick={(e) => e.stopPropagation()}>
        <span className={`mt-dot-inline ${station.online ? "on" : "off"}`} />
        <strong>{station.name}</strong>
        <span className="st-muted">
          {!station.online
            ? "오프라인"
            : mode === "video"
              ? "실시간 영상"
              : mode === "photo"
                ? "1초 간격 사진"
                : "연결 중…"}
        </span>
        <span className="mt-spacer" />
        <button className="st-btn" onClick={onClose}>닫기</button>
      </div>
      <div className="lv-body" onClick={(e) => e.stopPropagation()}>
        <video ref={videoRef} className="lv-video" style={{ display: mode === "video" ? "block" : "none" }} playsInline muted />
        {mode !== "video" && frame && <img className="lv-video" src={frame} alt="" />}
        {!station.online && <p className="st-muted">스테이션이 꺼져 있거나 네트워크가 끊겼습니다.</p>}
        {station.online && !frame && mode === "connecting" && <p className="st-muted">스테이션에 연결하는 중…</p>}
        {message && <p className="st-error">{message}</p>}
      </div>
    </div>
  );
}
