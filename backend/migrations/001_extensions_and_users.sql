-- 001: extensions + users table

CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
    id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    email              CITEXT      UNIQUE NOT NULL,
    password_hash      TEXT        NOT NULL,
    role               TEXT        NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
    is_active          BOOLEAN     NOT NULL DEFAULT true,
    access_expires_at  TIMESTAMPTZ,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS users_email_idx ON users (email);
