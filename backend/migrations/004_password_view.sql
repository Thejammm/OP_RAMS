-- 004: an encrypted, viewable copy of each password, for the admin (Simon's
-- decision, 12 Nov 2026). Sign-in still checks password_hash only. The copy is
-- AES-256-GCM with a key held only in the PASSWORD_VIEW_KEY environment variable,
-- never in the repo or this database. Users created before this have no copy
-- (NULL): a password cannot be recovered from its hash, so a copy appears the
-- next time the admin sets that user's password.

ALTER TABLE users ADD COLUMN IF NOT EXISTS password_enc TEXT;

-- Every time an admin looks at a password: who looked, whose, when.
CREATE TABLE IF NOT EXISTS password_views (
    id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    admin_id     UUID        REFERENCES users(id) ON DELETE SET NULL,
    admin_email  CITEXT      NOT NULL,
    user_id      UUID        REFERENCES users(id) ON DELETE SET NULL,
    user_email   CITEXT      NOT NULL,
    viewed_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS password_views_viewed_at_idx ON password_views (viewed_at);
