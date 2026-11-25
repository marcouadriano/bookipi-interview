-- Safe to run more than once.

CREATE TABLE IF NOT EXISTS sales (
  id           TEXT PRIMARY KEY,
  total_stock  INTEGER NOT NULL CHECK (total_stock >= 0),
  sold         INTEGER NOT NULL DEFAULT 0,
  CHECK (sold <= total_stock)
);

CREATE TABLE IF NOT EXISTS orders (
  id                BIGSERIAL PRIMARY KEY,
  sale_id           TEXT NOT NULL REFERENCES sales(id),
  user_id           TEXT NOT NULL,
  reserved_at       TIMESTAMPTZ NOT NULL,              -- purchase time, from Redis
  order_message_id  TEXT NOT NULL UNIQUE,              -- true purchase order
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(), -- when the row was saved
  UNIQUE (sale_id, user_id)                            -- one per user
);

-- Read-only view for the Sale Service's rebuild.
CREATE OR REPLACE VIEW sale_buyers AS
  SELECT sale_id, user_id FROM orders;
