# Tolly

An AI assistant and booking app for one barbershop.

Tolly is a fork of [OpenSalon](https://github.com/clawnify/OpenSalon) (MIT, Copyright (c) 2026 Clawnify). See [LICENSE](LICENSE).

## What it does

- **Clients text the shop.** Tolly, the assistant, answers first. It finds open times, books, moves, and cancels visits. Clients never install an app.
- **Clients can also book on a web page** (`/book`), pay a pre-pay with Stripe, and add the visit to their calendar.
- **Barbers use the dashboard.** They see the calendar, read and answer texts in the Inbox, record payments, and read reports.
- **Tolly is the barber's assistant too.** In a private chat it answers questions like "What do I have tomorrow?" and changes the schedule.
- **Automations** send texts by themselves: reminders, confirmations, a daily summary.
- **Reports** show the money really taken, for taxes and proof of income.

## How it works

```
  Client's phone                 Tolly server (Node + Hono)                 Barber
 ───────────────          ─────────────────────────────────────         ─────────────
                           ┌─────────────────────────────────┐
  SMS  ───── Telnyx ─────► │ /api/sms/*   webhook (signed)   │
       ◄──── (or Twilio) ─ │        │                        │
                           │        ▼                        │
                           │  Tolly, the AI agent            │ ◄────►  Dashboard (web)
  Booking page (/book) ──► │  client tools: own bookings only│          Inbox, Calendar,
  Web chat             ──► │  staff tools: the barber's chat │          Reports, Settings,
                           │        │                        │          private chat
                           │        ▼                        │
  Stripe pay page ◄──────► │  Bookings · Payments · Chats    │ ────►   Calendar feed
       (pre-pay)   webhook │  Automations (every minute)     │         (phone calendar)
                           └───────────────┬─────────────────┘
                                           ▼
                                Postgres (or embedded PGlite)
```

The order of work is: **client -> Tolly -> barber**. Tolly answers first. When it cannot help, it gives the chat to a barber.
When a barber writes in a chat, Tolly stops in that chat until the barber hands it back.

On a normal server, one process does everything: the API, the built web app, and the timers for automations and unpaid holds.
On Vercel, the API runs as a function, the web app is served as static files, and a schedule runs the timers. See [Deploy on Vercel](#deploy-on-vercel).

## Run it on your computer

You need Node.js 22 or newer and pnpm. You do not need a database or any keys.

```bash
pnpm install
```

```bash
pnpm dev
```

Open `http://localhost:5173`. The API runs on `http://localhost:8787`. The booking page is `http://localhost:5173/book`.

With no `DATABASE_URL`, Tolly uses an embedded Postgres (PGlite) and keeps its data in `./.data/pglite`.
On first start it adds sample data: 3 barbers, 6 services, 3 clients. Set `SEED_DEMO_DATA=false` to turn that off.

To run it the way a real server does:

```bash
pnpm build
```

```bash
pnpm start
```

`pnpm start` serves the API and the built web app on one port (`PORT`, default 8787).

## Settings (.env)

Copy `.env.example` to `.env` and fill in what you need. The server reads `.env` when it starts.
A variable that is already set (by your shell, Docker, or your host) wins over the file.

Every variable is listed and explained in [.env.example](.env.example). Never put secrets in the code, and never commit `.env`.

Everything is optional on your computer. With no keys, texts, pre-pay, and the assistant are off, and the rest still works.

## Set up Postgres

Use a real Postgres on a real server. Any recent Postgres works (your own, or a hosted one).

1. Create an empty database, for example `createdb tolly`.
2. Set `DATABASE_URL`, for example `postgres://user:password@localhost:5432/tolly`.
3. Start the server. Tolly creates its tables by itself. It is safe to start it again and again.

Set `SEED_DEMO_DATA=false` if you do not want the sample barbers and services.

## Set up the AI key

Set **one** of these:

- `AI_GATEWAY_API_KEY`: a Vercel AI Gateway key. It works with many model providers.
- `ANTHROPIC_API_KEY`: an Anthropic key, to call Anthropic directly.

Pick the model with `AGENT_MODEL`. With the gateway, write it as the gateway lists it (`provider/model`).
Check that the model name exists in your account before you go live.

With no key, the assistant is off and every chat goes straight to a barber.
Change the assistant's name, signature, and extra instructions in the dashboard under **Settings**.

## Set up texts (Telnyx)

Telnyx is the default provider.

1. Buy a number in the Telnyx portal and add it to a messaging profile.
2. Set `TELNYX_API_KEY`, `TELNYX_FROM_NUMBER`, and `TELNYX_PUBLIC_KEY`. `TELNYX_MESSAGING_PROFILE_ID` is optional. Set `PUBLIC_URL` too.
3. In the messaging profile, set the webhook address to `<PUBLIC_URL>/api/sms/telnyx`. **Settings -> Connections** shows the exact address.
4. Register the number (see below). Then send a text to the number to test it.

**Register before you text US numbers (10DLC)**

US carriers block texts from numbers that are not registered. Do this first. It can take days or weeks.

- A normal 10-digit number needs **A2P 10DLC** registration. In the Telnyx portal: register your business as a "brand". Then make a "campaign" that says what you send (appointment texts) and how clients agree to it. Then link the number to the campaign.
- A toll-free number (800, 888, ...) needs **toll-free verification** instead.

The booking page shows the consent line carriers ask for: "We'll text you about this booking. Reply STOP to opt out."

**Or Twilio**

Set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`, and `PUBLIC_URL`. On the number, set "A message comes in" to `<PUBLIC_URL>/api/sms/twilio` (HTTP POST). Twilio needs the same 10DLC registration. If both providers have keys, set `SMS_PROVIDER`.

**How texts work**

- Every webhook is checked: Telnyx with an Ed25519 signature (and not older than 5 minutes), Twilio with its HMAC signature.
- One thread per phone number. The number a text comes from is the client. Tolly can only see, move, or cancel bookings of that number.
- STOP (also STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT, REVOKE, OPTOUT) turns texts off for that number. START or UNSTOP turns them on again.
- Each text we send is saved as "sent" or "failed" with the reason. The Inbox shows failed texts.
- The barber reads and answers in the Inbox, not on their own phone.

## Set up payments (Stripe)

Clients can pay part or all of the price when they book online. We call this "pre-pay".

1. Put your Stripe secret key in `STRIPE_SECRET_KEY`, and the public address of the server in `PUBLIC_URL`.
2. In the Stripe Dashboard, add a webhook endpoint at `<PUBLIC_URL>/api/stripe/webhook`. Send these events:
   - `checkout.session.completed`
   - `checkout.session.async_payment_succeeded`
   - `checkout.session.async_payment_failed`
   - `checkout.session.expired`
   - `charge.refunded`
3. Put the signing secret of that endpoint in `STRIPE_WEBHOOK_SECRET`.
4. In **Settings -> Pre-pay**, choose what clients pay: nothing, a fixed amount, a percent of the price, or the full price. Set the refund window (hours) and the hold time (minutes) too.

To test on your computer, use test keys and `stripe listen --forward-to localhost:8787/api/stripe/webhook`.

**How pre-pay works**

1. The client books. The booking is "Waiting for pre-pay" and the time is held.
2. The client pays on a Stripe page. Stripe tells the server, and the booking is confirmed.
3. If the client does not pay before the hold ends, the booking is cancelled and the time is open again.
4. If the client pays after the hold ended, the booking is confirmed only if the time is still free. If not, the appointment gets a note that asks you to refund the payment in Stripe.
5. If the client cancels at least the refund window before the visit, the pre-pay is refunded automatically. Later than that, it is not refunded. A change made by staff never refunds by itself.

Without `STRIPE_SECRET_KEY` there is no pre-pay, and bookings are confirmed at once.

**Payments in the shop**

Take the card with the Stripe Dashboard app (tap to pay), or take cash. Then open the appointment in the dashboard and record the payment and the tip.
Reports count every recorded payment and every pre-pay.

## Deploy

The [Dockerfile](Dockerfile) builds the web app and runs the server. One container is the whole app.

```bash
docker build -t tolly .
```

```bash
docker run -p 8787:8787 --env-file .env tolly
```

The image sets `NODE_ENV=production`. **In production the server does not start without `STAFF_PASSWORD`.**

Set these on a real server:

| Variable | Why |
| --- | --- |
| `STAFF_PASSWORD` | Protects the dashboard. Staff share this one password. Required. |
| `SESSION_SECRET` | Keeps staff logged in when the server restarts. |
| `DATABASE_URL` | A real Postgres. Without it, data lives inside the container and is lost with it. |
| `PUBLIC_URL` | The https address clients reach. Links in texts, payment pages, and calendar files use it. |
| `TRUST_PROXY` | `1` if a reverse proxy or load balancer is in front (it almost always is). |
| `SHOP_TIMEZONE` | The shop's time zone, until you save one in Settings. |

Then add the keys for texts, Stripe, and the AI from the sections above.

Good to know:

- Serve it over **https**. Put a proxy in front (Caddy, nginx, or your host's own), and make sure the server port can be reached only through that proxy.
- Without `TRUST_PROXY`, every visitor behind the proxy looks like one address. They then share one login limit and one web chat limit.
- Run **one** container. The login limit and the chat limit are kept in the database, but the assistant's queue for each chat lives in that one process.
- The health check is `GET /api/health`.
- Without Docker: `pnpm install`, `pnpm build`, then `NODE_ENV=production pnpm start` does the same.

## Deploy on Vercel

Tolly also runs on Vercel. [vercel.json](vercel.json) holds the whole setup:

- `pnpm build` makes the web app. Vercel serves it as static files.
- [api/index.ts](api/index.ts) is one function for all of `/api/*`.
- [api/tick.ts](api/tick.ts) is a private function. The schedule `tick` runs it every minute. It releases unpaid holds, runs the automations, and cleans up.

Steps:

1. Import the repository in Vercel. Keep the settings from `vercel.json`.
2. Add a Postgres database from the Vercel Marketplace (for example Neon). Use its **pooled** connection string as `DATABASE_URL`.
3. Set these in the project's environment variables. Without the first three, the API answers "Tolly is not set up yet."

| Variable | Why |
| --- | --- |
| `DATABASE_URL` | Required. There is no embedded database on Vercel. |
| `STAFF_PASSWORD` | Required. Protects the dashboard. |
| `SESSION_SECRET` | Required. All functions must sign the login cookie with the same key. |
| `PUBLIC_URL` | The https address of the deployment or your own domain. |
| `SEED_DEMO_DATA` | Set it to `false`, or the first request adds the sample barbers and services. |
| `SHOP_TIMEZONE` | The shop's time zone, until you save one in Settings. |

4. Add the keys for texts, Stripe, and the AI. Point the Telnyx and Stripe webhooks at the Vercel address.
5. Deploy.

Good to know:

- **The schedule runs every minute. That needs a Pro plan.** On Hobby, a schedule can run every 15 minutes at most, and the deploy may fail. Change `schedule` in `vercel.json` to `*/15 * * * *` there. Reminders and the release of unpaid holds are then up to 15 minutes late (more with Vercel's jitter).
- Leave `TRUST_PROXY` and `CRON_SECRET` empty.
- Tolly creates its tables on the first request.
- Bookings are safe when many functions run at once: every booking write takes a lock in the database. The login limit and the chat limit are in the database too.
- The assistant answers after the request ends. A function can run for 5 minutes at most (`maxDuration` in `vercel.json`).
- Each function keeps its own queue per chat. If two texts from one client reach two functions at the same moment, Tolly may answer each of them by itself.
- `pnpm start` and the Dockerfile still work the same as before.

## Using it

**Staff login.** After 5 wrong passwords, that address must wait 5 minutes. To end every login at once, change `STAFF_PASSWORD` or `SESSION_SECRET`.

**Booking page.** Clients book at `/book`. They pick services, a barber, and a time. Each booking gets a private link (`/book/manage/...`) where the client can see it, cancel it, or add it to Google Calendar or iPhone Calendar.

**Inbox.** All texts and web chats. "Take over" stops the assistant in that chat. "Hand back to AI" starts it again. Staff notes are for staff only.

**Assistant.** The barber's private chat with Tolly, at `/assistant`. Clients never see it.

**Automations.** Routines that run by themselves: every day at a set time, before or after a visit, or when a booking is made, paid, moved, or cancelled. A routine sends a text to the client, or gives Tolly a task. Links in these texts need `PUBLIC_URL`.

**Reports.** "Bookings" shows what was on the calendar. "Income & taxes" shows the money really taken, by month, by barber, and by payment method, with tips and refunds. Download it as CSV, or print it as a PDF.

**Calendar feed.** In Settings, each barber gets a link to subscribe to their bookings in their phone's calendar. The feed has client names, so keep the link private. "Reset" makes a new link and the old one stops working.

**Settings.** Shop name, time zone, address, opening hours, how often times start, the minimum notice, how many days ahead clients can book, pre-pay, and the assistant's name.

**On an iPhone.** Open the dashboard in Safari. Use Share -> "Add to Home Screen" to open it like an app.

## Privacy rules

- With a client, Tolly shares only that client's own bookings. It never shares anyone else's schedule or details.
- In the web chat nobody checks the phone number. So Tolly cannot look up, move, or cancel a booking there. It sends the client to the manage link.
- Clients never see staff notes or the barber's private chat.
- Private links use long random tokens. A wrong token gets a plain "not found".
- Logs never hold a full phone number, a message, or a token.
- The web chat takes 20 messages a minute from one address.

`src/server/privacy.test.ts` tries to break each of these rules.

## Tests

```bash
pnpm typecheck
```

```bash
pnpm test
```

```bash
pnpm build
```

Tests use an in-memory database, a fake Stripe, a fake SMS provider, and a mock AI model. They do not need the network or any keys.

## Tech

- Node.js 22+, pnpm, TypeScript.
- Server: Hono + @hono/zod-openapi on Node. The OpenAPI document is at `/api/openapi.json`.
- Database: Postgres through `pg`, or embedded PGlite when `DATABASE_URL` is empty.
- Web: Preact + Vite + Tailwind + shadcn/ui. Two pages: the dashboard (`index.html`) and the booking page (`book.html`).
- AI: Vercel AI SDK with tools.

## License

MIT. See [LICENSE](LICENSE).
