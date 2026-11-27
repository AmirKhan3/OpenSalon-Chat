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
