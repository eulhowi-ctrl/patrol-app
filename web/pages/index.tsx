import Head from "next/head";
import dynamic from "next/dynamic";

// getUserMedia/Canvas는 브라우저 전용 API이므로 SSR을 비활성화한다.
const CameraView = dynamic(() => import("../src/components/CameraView"), {
  ssr: false,
});

export default function Home() {
  return (
    <>
      <Head>
        <title>ARGUS - AI Safety Patrol System</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="manifest" href="/manifest.json" />
        <meta name="theme-color" content="#0b1220" />
      </Head>
      <main>
        <div style={{ textAlign: "center", marginBottom: "16px" }}>
          <h1 style={{ margin: "8px 0 4px 0", fontSize: "32px", fontWeight: "bold", color: "#e8edf5" }}>
            ARGUS
          </h1>
          <p style={{ fontSize: "13px", color: "#7a94c4", margin: "0", letterSpacing: "0.5px", fontWeight: "500" }}>
            AI Safety Patrol System
          </p>
        </div>
        <CameraView />
      </main>
    </>
  );
}
