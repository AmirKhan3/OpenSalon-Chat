# Tolly

An AI assistant and booking app for one barbershop: scheduling, messaging, automations, and reports.

Tolly is a fork of [OpenSalon](https://github.com/clawnify/OpenSalon) (MIT, Copyright (c) 2026 Clawnify). See [LICENSE](LICENSE).

This README is short on purpose. It grows as the app is built.

## Run it on your computer

You need Node.js 22 or newer and pnpm. You do not need a database.

```bash
pnpm install
pnpm dev
```

Open `http://localhost:5173`. The API runs on `http://localhost:8787`.

With no `DATABASE_URL`, Tolly uses an embedded Postgres (PGlite) and keeps its data in `./.data/pglite`.
On first start it adds sample data: 3 barbers, 6 services, 3 clients. Set `SEED_DEMO_DATA=false` to turn that off.

## Run it like production

```bash
pnpm build
pnpm start
```

`pnpm start` serves the API and the built web app on one port (`PORT`, default 8787).

## Use a real Postgres

Set `DATABASE_URL`, for example:

```bash
DATABASE_URL=postgres://user:password@localhost:5432/tolly pnpm start
```

Tolly creates its tables on start. It is safe to start it again and again.

## Staff login

Set `STAFF_PASSWORD` to protect the dashboard. Staff share this one password.
Set `SESSION_SECRET` too, so logins survive a restart.

- With `NODE_ENV=production`, the server does not start without `STAFF_PASSWORD`.
- In development, an empty `STAFF_PASSWORD` turns login off.
- After 5 wrong passwords, that address must wait 5 minutes.
- Behind a reverse proxy, set `TRUST_PROXY=1`. Then make sure the server port can be reached only through the proxy.
- Always set `NODE_ENV=production` on a real server.
- Logging out clears the cookie in that browser. To end every login at once, change `STAFF_PASSWORD` or `SESSION_SECRET`.

## Client booking page

Clients book at `/book` (in development: `http://localhost:5173/book`). They pick services, a barber, and a time.
Each booking gets a private link (`/book/manage/...`) where the client can see or cancel it.

In the dashboard, open **Settings** to set the shop name, time zone, address, opening hours,
how often times start, the minimum notice, and how many days ahead clients can book.
All times are stored in shop time. `SHOP_TIMEZONE` is the time zone used until you save one.

## Pre-pay with Stripe

Clients can pay part or all of the price when they book online. We call this "pre-pay".

In Settings -> Pre-pay, choose what clients pay: nothing, a fixed amount, a percent of the price, or the full price.
You also set the refund window (hours) and the hold time (minutes, at least 30).

How it works:

1. The client books. The booking is "Waiting for pre-pay" and the time is held.
2. The client pays on a Stripe page. Stripe tells the server, and the booking is confirmed.
3. If the client does not pay before the hold ends, the booking is cancelled and the time is open again.
4. If the client pays after the hold ended, the booking is confirmed only if the time is still free. If not, the appointment gets a note that asks you to refund the payment in Stripe.
5. If the client cancels at least the refund window before the visit, the pre-pay is refunded automatically. Later than that, it is not refunded.

Set it up:

1. Put your Stripe secret key in `STRIPE_SECRET_KEY`, and the public address of the server in `PUBLIC_URL`.
2. In the Stripe Dashboard, add a webhook endpoint at `<PUBLIC_URL>/api/stripe/webhook` with these events:
   `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
   `checkout.session.async_payment_failed`, `checkout.session.expired`, `charge.refunded`.
3. Put the signing secret of that endpoint in `STRIPE_WEBHOOK_SECRET`.

Without `STRIPE_SECRET_KEY` there is no pre-pay, and bookings are confirmed at once.
To test on your computer, use test keys and `stripe listen --forward-to localhost:8787/api/stripe/webhook`.

## The assistant and chat

Clients chat with the shop from the booking page. The assistant answers first. Its name is "Tolly" by default.
It can list services, find open times, and book a visit. When it cannot help, it gives the chat to a barber.

- Barbers read and answer chats in the dashboard at `/inbox`. "Take over" stops the assistant. "Hand back to AI" starts it again.
- When a barber writes a reply, the assistant stops in that chat by itself.
- Staff notes in a chat are for staff only. Clients and the assistant never see them.
- The barber has a private chat with the assistant at `/assistant`. Clients never see it.
- In the web chat nobody checks the phone number. So the assistant cannot look up, move, or cancel a booking there. It sends the client to the manage link.

To turn the assistant on, set `AI_GATEWAY_API_KEY` (Vercel AI Gateway) or `ANTHROPIC_API_KEY`. Pick the model with `AGENT_MODEL`.
With no key, every chat goes straight to a barber.
Change the assistant's name, signature, and extra instructions in the dashboard under Settings.

## Texts (SMS)

Clients text the shop. Tolly answers first. A barber reads and answers in the Inbox, not on their own phone.

**Set up Telnyx (default)**

1. Buy a number in the Telnyx portal and add it to a messaging profile.
2. Set `TELNYX_API_KEY`, `TELNYX_FROM_NUMBER` and `TELNYX_PUBLIC_KEY` (and `TELNYX_MESSAGING_PROFILE_ID` if you like). Set `PUBLIC_URL` too.
3. In the messaging profile, set the webhook address to `<PUBLIC_URL>/api/sms/telnyx`. Settings -> Connections shows the exact address.

**Or Twilio**

Set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` and `PUBLIC_URL`. On the number, set "A message comes in" to `<PUBLIC_URL>/api/sms/twilio` (HTTP POST). If both providers have keys, set `SMS_PROVIDER`.

**Register before you text US numbers**

US carriers block texts from numbers that are not registered. Do this first. It can take days or weeks.

- A normal 10-digit number needs **A2P 10DLC** registration: register your business as a "brand", then a "campaign" that says what you send (appointment texts) and how clients agree to it, then link the number to the campaign. Both Telnyx and Twilio have this in their portal.
- A toll-free number (800, 888, ...) needs **toll-free verification** instead.

The booking page shows the consent line carriers ask for: "We'll text you about this booking. Reply STOP to opt out."

**How it works**

- Every webhook is checked: Telnyx with an Ed25519 signature (and not older than 5 minutes), Twilio with its HMAC signature. The server answers the webhook at once and runs the assistant after.
- One thread per phone number. The number a text comes from is the client. Tolly never asks for it and can only see, move or cancel bookings of that number.
- STOP (also STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT) turns texts off for that number. START or UNSTOP turns them on again. HELP is answered by the provider.
- Each text we send is saved as "sent" or "failed" with the reason. The Inbox shows failed texts.

## Settings

Copy `.env.example` to `.env` and fill in what you need. Never put secrets in the code.

## Checks

```bash
pnpm typecheck
pnpm test
pnpm build
```

Tests use an in-memory database. They do not need the network.

## Tech

- Server: Hono + @hono/zod-openapi on Node. The OpenAPI document is at `/api/openapi.json`.
- Database: Postgres through `pg`, or embedded PGlite when `DATABASE_URL` is empty.
- Web: Preact + Vite + Tailwind + shadcn/ui.

## License

MIT. See [LICENSE](LICENSE).
