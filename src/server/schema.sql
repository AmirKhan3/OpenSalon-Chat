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
