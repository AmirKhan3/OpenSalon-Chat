// The Vercel function for the every-minute work. It has no public address:
// only the Vercel schedule "tick" (vercel.json) can call it.
import { handleSchedule } from "@vercel/schedules";
import { runScheduled } from "../src/server/vercel.js";

export const POST = handleSchedule(async () => {
  await runScheduled();
});
