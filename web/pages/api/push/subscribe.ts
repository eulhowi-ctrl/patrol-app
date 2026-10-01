import type { NextApiRequest, NextApiResponse } from "next";
import { addSubscription, type StoredPushSubscription } from "../../../src/lib/server/pushStore";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "POST만 허용됩니다." });
  }

  const sub = req.body as Partial<StoredPushSubscription> | undefined;
  if (!sub?.endpoint || !sub.keys?.p256dh || !sub.keys?.auth) {
    return res.status(400).json({ error: "유효한 push subscription이 아닙니다." });
  }

  await addSubscription({
    endpoint: sub.endpoint,
    keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
  });
  return res.status(200).json({ ok: true });
}
