# Tolly: AI assistant for barbers

## What this is
A booking, scheduling, messaging, automation, and reporting app for one barbershop.
The AI agent is named "Tolly". It is a fork of OpenSalon (MIT, Copyright (c) 2026 Clawnify).
Keep the LICENSE file and the Clawnify copyright notice.

## Who uses it
- The buyer is a barber with an established clientele. They do not need marketing features.
- Clients use SMS only. For them, the experience must feel like texting the barber. They never install an app.
- Barbers use the web dashboard. Tolly is their personal assistant: it does their admin work and they also have normal management tools.

## Order of work
Client -> Tolly (agent) -> Barber. Tolly answers first. Tolly gives the chat to a barber when it cannot help.

## Rules for Tolly
- With clients: Tolly shares ONLY that client's own bookings, never anyone else's schedule or details.
  Tolly can do scheduling tasks (find open times, book, move, cancel). This is a privacy requirement. Treat it as a hard rule.
- With barbers: Tolly makes reports, manages schedules, and sends messages to many clients (with routines called "automations").
- Tolly signs its texts to clients, for example: "Here are your open times! - Tolly". The name is a setting.
- Clients never see the barber's private chat with Tolly, or staff-only notes.

## Product rules
- SMS is the main channel. Provider: Telnyx (default). Twilio is optional.
- The barber reads and answers texts in the app, not on their own phone.
- Payments: Stripe. "Pre-pay" (not "deposit") can be none, a fixed amount, a percent, or the full price.
- The barber prefers tap to pay on iPhone. That needs a native iPhone app (later). Until then, the barber uses the Stripe Dashboard app and records the payment in our app.
- Reports must support taxes and proof of income (money really taken), and also show recent progress.
- Clients can add their appointment to Google Calendar or iPhone Calendar. Barbers can subscribe to a calendar feed of their bookings.

## Tech
- Node.js 22+, pnpm, TypeScript.
- Server: Hono + @hono/zod-openapi on Node (@hono/node-server).
- Database: Postgres through `pg` in production. Embedded PGlite in development and tests when DATABASE_URL is empty.
- Web: Preact + Vite + Tailwind + shadcn/ui, with Konsta UI (konsta/react, through preact/compat) for phone screens. Two pages: staff dashboard (index.html) and client booking page (book.html at /book).
- Barbers mostly use the dashboard on a phone. Build phone-first: bottom tab bar (mobile-nav.tsx), large touch targets. The sidebar is for desktop only.
- AI: Vercel AI SDK with tools. Model from AGENT_MODEL, through the AI Gateway (AI_GATEWAY_API_KEY) or Anthropic directly (ANTHROPIC_API_KEY).
- Tests: node --test with tsx. Use PGlite in memory, a fake Stripe, a fake SMS provider, and a mock AI model. Tests must not need the network.

## Working rules
- Run `pnpm typecheck`, `pnpm test`, and `pnpm build` before you finish a task.
- Every new feature needs tests.
- Never put secrets in the code. Use environment variables, and list them in .env.example.
- Write user-facing text in plain, short sentences.
