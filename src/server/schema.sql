-- Tolly schema for Postgres. Every statement is idempotent: this file is
-- applied on every server start.

-- Timestamps are stored as UTC text ("YYYY-MM-DD HH:MM:SS").
CREATE OR REPLACE FUNCTION utc_now() RETURNS TEXT
  LANGUAGE sql STABLE
  AS $$ SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') $$;

CREATE OR REPLACE FUNCTION utc_today() RETURNS TEXT
  LANGUAGE sql STABLE
  AS $$ SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD') $$;

-- Clients (people who book appointments)
CREATE TABLE IF NOT EXISTS clients (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT DEFAULT '',
  phone TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  created_at TEXT DEFAULT utc_now(),
  updated_at TEXT DEFAULT utc_now()
);

-- Staff (barbers)
CREATE TABLE IF NOT EXISTS staff (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT DEFAULT '',
  phone TEXT DEFAULT '',
  title TEXT DEFAULT '',
  color TEXT NOT NULL DEFAULT '#7c3aed',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT utc_now()
);

-- Services (haircut, beard trim, ...)
CREATE TABLE IF NOT EXISTS services (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  duration INTEGER NOT NULL DEFAULT 60,
  price DOUBLE PRECISION NOT NULL DEFAULT 0,
  color TEXT NOT NULL DEFAULT '#6b7280',
  category TEXT DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT utc_now()
);

-- Appointments (bookings)
CREATE TABLE IF NOT EXISTS appointments (
  id SERIAL PRIMARY KEY,
  identifier TEXT NOT NULL UNIQUE,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  staff_id INTEGER REFERENCES staff(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'booked',
  scheduled_date TEXT NOT NULL DEFAULT utc_today(),
  start_time TEXT NOT NULL DEFAULT '09:00',
  end_time TEXT NOT NULL DEFAULT '10:00',
  total_price DOUBLE PRECISION NOT NULL DEFAULT 0,
  notes TEXT DEFAULT '',
  is_recurring INTEGER NOT NULL DEFAULT 0,
  recurrence_interval TEXT DEFAULT '',
  created_at TEXT DEFAULT utc_now(),
  updated_at TEXT DEFAULT utc_now()
);

-- Services included in an appointment (many-to-many)
CREATE TABLE IF NOT EXISTS appointment_services (
  id SERIAL PRIMARY KEY,
  appointment_id INTEGER NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  service_id INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  price DOUBLE PRECISION NOT NULL DEFAULT 0,
  duration INTEGER NOT NULL DEFAULT 60
);

-- Appointment notes / activity log
CREATE TABLE IF NOT EXISTS appointment_notes (
  id SERIAL PRIMARY KEY,
  appointment_id INTEGER NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  created_at TEXT DEFAULT utc_now()
);

-- Blocked time (breaks, days off, lunch, ...)
CREATE TABLE IF NOT EXISTS blocked_slots (
  id SERIAL PRIMARY KEY,
  staff_id INTEGER NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  blocked_date TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  reason TEXT DEFAULT '',
  created_at TEXT DEFAULT utc_now()
);

-- Products (retail stock)
CREATE TABLE IF NOT EXISTS products (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  brand TEXT DEFAULT '',
  category TEXT DEFAULT '',
  sku TEXT DEFAULT '',
  price DOUBLE PRECISION NOT NULL DEFAULT 0,
  cost DOUBLE PRECISION NOT NULL DEFAULT 0,
  stock INTEGER NOT NULL DEFAULT 0,
  low_stock_alert INTEGER NOT NULL DEFAULT 5,
  created_at TEXT DEFAULT utc_now(),
  updated_at TEXT DEFAULT utc_now()
);

-- Key/value rows (appointment identifier counter)
CREATE TABLE IF NOT EXISTS _meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Shop settings. Each value is JSON.
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT DEFAULT utc_now()
);

-- Columns added after the first version.
-- public_token: the secret in the client's manage link.
-- source: who made the booking (staff | online | chat | sms).
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS public_token TEXT;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'staff';
CREATE UNIQUE INDEX IF NOT EXISTS idx_appointments_public_token ON appointments(public_token);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_appointments_client ON appointments(client_id);
CREATE INDEX IF NOT EXISTS idx_appointments_staff ON appointments(staff_id);
CREATE INDEX IF NOT EXISTS idx_appointments_date ON appointments(scheduled_date);
CREATE INDEX IF NOT EXISTS idx_appointments_status ON appointments(status);
CREATE INDEX IF NOT EXISTS idx_appointment_services_apt ON appointment_services(appointment_id);
CREATE INDEX IF NOT EXISTS idx_appointment_notes_apt ON appointment_notes(appointment_id);
CREATE INDEX IF NOT EXISTS idx_blocked_slots_staff ON blocked_slots(staff_id);
CREATE INDEX IF NOT EXISTS idx_blocked_slots_date ON blocked_slots(blocked_date);
CREATE INDEX IF NOT EXISTS idx_clients_name ON clients(name);
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category);
CREATE INDEX IF NOT EXISTS idx_services_category ON services(category);

-- Pre-pay (Stripe). prepay_status: none | due | paid | refunded | refund_due | expired | void.
-- hold_expires_at: UTC time (ISO text). A pending booking holds its time until then.
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS prepay_amount DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS prepay_status TEXT NOT NULL DEFAULT 'none';
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS hold_expires_at TEXT;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS stripe_session_id TEXT;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS stripe_checkout_url TEXT;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS stripe_payment_intent TEXT;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS stripe_refund_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_appointments_stripe_session ON appointments(stripe_session_id);

-- Chat threads. kind 'client': a client talks with Tolly and the barbers.
-- kind 'assistant': the barber's private chat with Tolly. Clients never see it.
-- token: the secret a web chat keeps in the browser. phone: the number of an SMS thread.
-- mode 'agent': Tolly answers. mode 'human': a barber answers and Tolly stays quiet.
CREATE TABLE IF NOT EXISTS chat_threads (
  id SERIAL PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'client',
  channel TEXT NOT NULL DEFAULT 'web',
  token TEXT UNIQUE,
  phone TEXT,
  client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL,
  display_name TEXT NOT NULL DEFAULT '',
  mode TEXT NOT NULL DEFAULT 'agent',
  needs_attention INTEGER NOT NULL DEFAULT 0,
  staff_unread INTEGER NOT NULL DEFAULT 0,
  last_message_at TEXT,
  created_at TEXT DEFAULT utc_now(),
  updated_at TEXT DEFAULT utc_now()
);

-- sender: client | agent | staff | system | note.
-- 'note' is for staff only. Clients and the AI never see notes.
-- delivery_status: for texts, 'sent' or 'failed: <reason>'. Empty for web chat.
CREATE TABLE IF NOT EXISTS chat_messages (
  id SERIAL PRIMARY KEY,
  thread_id INTEGER NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
  sender TEXT NOT NULL,
  body TEXT NOT NULL,
  delivery_status TEXT NOT NULL DEFAULT '',
  created_at TEXT DEFAULT utc_now()
);
CREATE INDEX IF NOT EXISTS idx_chat_messages_thread ON chat_messages(thread_id, id);
CREATE INDEX IF NOT EXISTS idx_chat_threads_phone ON chat_threads(phone);

-- Texts (SMS).
-- opted_out: the client texted STOP. We send this number no more texts until they text START.
-- provider_ref: the provider's id of a text. It stops a webhook that arrives twice from being saved twice.
ALTER TABLE chat_threads ADD COLUMN IF NOT EXISTS opted_out INTEGER NOT NULL DEFAULT 0;
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS provider_ref TEXT;
CREATE INDEX IF NOT EXISTS idx_chat_messages_ref ON chat_messages(provider_ref);

-- Automations: routines the owner (or the assistant) sets up once. The server runs them.
-- trigger: daily | before_appointment | after_appointment | booking_created | prepay_paid | booking_cancelled | booking_moved
-- action: text_client | agent_task
-- created_by: system | staff | agent
-- armed_at: when it was made, turned on, or its timing changed. It never fires for a moment before that.
CREATE TABLE IF NOT EXISTS automations (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  trigger TEXT NOT NULL,
  trigger_config TEXT NOT NULL DEFAULT '{}',
  action TEXT NOT NULL,
  action_config TEXT NOT NULL DEFAULT '{}',
  filters TEXT NOT NULL DEFAULT '{}',
  created_by TEXT NOT NULL DEFAULT 'staff',
  builtin_key TEXT,
  armed_at TEXT NOT NULL,
  created_at TEXT DEFAULT utc_now(),
  updated_at TEXT DEFAULT utc_now()
);

-- One row per time an automation acted. run_key is claimed BEFORE acting,
-- so the same reminder is never sent twice.
-- status: running | sent | done | skipped | failed
CREATE TABLE IF NOT EXISTS automation_runs (
  id SERIAL PRIMARY KEY,
  automation_id INTEGER NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  appointment_id INTEGER REFERENCES appointments(id) ON DELETE SET NULL,
  run_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'running',
  detail TEXT NOT NULL DEFAULT '',
  created_at TEXT DEFAULT utc_now()
);
CREATE INDEX IF NOT EXISTS idx_automation_runs_automation ON automation_runs(automation_id, id);
