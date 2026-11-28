// The Vercel function for /api/*. See src/server/vercel.ts.
import { handle } from "../src/server/vercel.js";

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
export const OPTIONS = handle;
export const HEAD = handle;
