import { existsSync, readFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import app from "./index.js";
import { closeDB, initDB } from "./db.js";
import { ensureSeeded } from "./seed.js";

/**
 * The Node server: the API plus the built web app from dist/.
 *
 * - /api/*              the API
 * - paths with a file extension (".js", ".css", ".png", ...): static files
 * - /book and /book/*   the client booking page (book.html)
 * - everything else     the staff dashboard (index.html)
 */

const DIST = resolve(process.cwd(), "dist");

function page(name: string): string | null {
  const file = resolve(DIST, name);
  return existsSync(file) ? readFileSync(file, "utf8") : null;
}

const NOT_BUILT =
  "<!doctype html><meta charset=utf-8><title>Tolly</title>" +
  "<p>The web app is not built yet. Run <code>pnpm build</code>, " +
  "or use <code>pnpm dev</code> and open the Vite address.</p>";

export function createServerApp(): Hono {
  const root = new Hono();

  root.all("/api/*", (c) => app.fetch(c.req.raw));

  // serveStatic wants a root relative to the working directory.
  const files = serveStatic({ root: "./dist" });
  root.get("*", async (c, next) => {
    // Only paths with a file extension go to the static handler.
    if (extname(c.req.path) === "") return next();
    let missing = false;
    const res = await files(c, async () => { missing = true; });
    if (missing || !res) return c.text("Not found", 404);
    return res;
  });

  root.get("*", (c) => {
    if (extname(c.req.path) !== "") return c.text("Not found", 404);
    const isBooking = c.req.path === "/book" || c.req.path.startsWith("/book/");
    // The booking page arrives in a later step. Until then, show the dashboard.
    const html = (isBooking ? page("book.html") : null) ?? page("index.html");
    if (!html) return c.html(NOT_BUILT, 503);
    return c.html(html);
  });

  return root;
}

async function main(): Promise<void> {
  const port = Number(process.env.PORT) || 8787;
  await initDB();
  await ensureSeeded();
  const server = serve({ fetch: createServerApp().fetch, port }, (info) => {
    const db = (process.env.DATABASE_URL ?? "").trim();
    const where = db === "" || db.startsWith("pglite:") ? "embedded PGlite" : "Postgres";
    console.log(`Tolly is running at http://localhost:${info.port} (database: ${where})`);
  });
  const stop = () => {
    server.close(() => {
      closeDB().finally(() => process.exit(0));
    });
    // Do not hang on open connections.
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

// Start only when this file is the entry point (not when a test imports it).
const entry = process.argv[1] ? resolve(process.argv[1]) : "";
if (entry.endsWith("server.ts") || entry.endsWith("server.js")) {
  main().catch((err) => {
    console.error("Tolly could not start:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
