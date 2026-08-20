import { useState } from "react";
import Head from "next/head";
import dynamic from "next/dynamic";
import Dashboard from "../src/components/Dashboard";

// getUserMedia/Canvas는 브라우저 전용 API이므로 SSR을 비활성화한다.
const CameraView = dynamic(() => import("../src/components/CameraView"), {
  ssr: false,
});

type View = "dashboard" | "patrol";

export default function Home() {
  const [view, setView] = useState<View>("dashboard");

  return (
    <>
      <Head>
        <title>ARGUS - AI Safety Patrol System</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="manifest" href="/manifest.json" />
        <meta name="theme-color" content="#0b1220" />
      </Head>
      <main>
        {view === "dashboard" ? (
          <Dashboard onEnterPatrol={() => setView("patrol")} />
        ) : (
          <CameraView onBack={() => setView("dashboard")} />
        )}
      </main>
    </>
  );
}
