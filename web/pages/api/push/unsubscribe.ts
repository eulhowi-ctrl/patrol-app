import type { NextApiRequest, NextApiResponse } from "next";
import { removeSubscription } from "../../../src/lib/server/pushStore";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "POST만 허용됩니다." });
  }

  const { endpoint } = (req.body ?? {}) as { endpoint?: unknown };
  if (typeof endpoint !== "string" || !endpoint) {
    return res.status(400).json({ error: "endpoint가 필요합니다." });
  }

  await removeSubscription(endpoint);
  return res.status(200).json({ ok: true });
}
