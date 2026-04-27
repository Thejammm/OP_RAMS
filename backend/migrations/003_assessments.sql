-- 003: assessments (the OP RAMS state, stored as JSONB per user)

CREATE TABLE IF NOT EXISTS assessments (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name        TEXT        NOT NULL,
    state       JSONB       NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS assessments_user_id_idx ON assessments (user_id);
CREATE INDEX IF NOT EXISTS assessments_updated_idx ON assessments (user_id, updated_at DESC);

-- Migration tracking table (used by scripts/migrate.js)
CREATE TABLE IF NOT EXISTS _migrations (
    name        TEXT        PRIMARY KEY,
    applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
