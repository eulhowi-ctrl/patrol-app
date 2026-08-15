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
        <title>직책자 순찰앱</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="manifest" href="/manifest.json" />
        <meta name="theme-color" content="#0b1220" />
      </Head>
      <main>
        <h1>직책자 순찰앱</h1>
        <CameraView />
      </main>
    </>
  );
}
