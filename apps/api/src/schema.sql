CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY,
  device_id text UNIQUE NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS meeting_sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'active',
  job_title text,
  company text,
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz
);

CREATE TABLE IF NOT EXISTS transcripts (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES meeting_sessions(id) ON DELETE CASCADE,
  kind text NOT NULL,
  text text NOT NULL DEFAULT '',
  payload jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS screen_events (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES meeting_sessions(id) ON DELETE CASCADE,
  image_ref text,
  ocr_text text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS meeting_sessions_user_idx ON meeting_sessions (user_id, started_at DESC);
CREATE INDEX IF NOT EXISTS transcripts_session_idx ON transcripts (session_id, created_at);
CREATE INDEX IF NOT EXISTS screen_events_session_idx ON screen_events (session_id, created_at);

CREATE TABLE IF NOT EXISTS resumes (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title text NOT NULL DEFAULT 'Resume',
  raw_text text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS resume_chunks (
  id uuid PRIMARY KEY,
  resume_id uuid NOT NULL REFERENCES resumes(id) ON DELETE CASCADE,
  ordinal int NOT NULL,
  text text NOT NULL,
  embedding jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS user_profiles (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  active_resume_id uuid REFERENCES resumes(id) ON DELETE SET NULL,
  job_title text,
  company text,
  requirements text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS resumes_user_idx ON resumes (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS resume_chunks_resume_idx ON resume_chunks (resume_id, ordinal);

ALTER TABLE meeting_sessions ADD COLUMN IF NOT EXISTS summary text;
ALTER TABLE meeting_sessions ADD COLUMN IF NOT EXISTS meeting_app text;

ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS default_track text NOT NULL DEFAULT 'auto';
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS plan text NOT NULL DEFAULT 'free';

CREATE TABLE IF NOT EXISTS user_documents (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL,
  title text NOT NULL,
  raw_text text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS user_documents_user_kind_idx
  ON user_documents (user_id, kind, created_at DESC);

ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS stories_status text NOT NULL DEFAULT 'empty';

CREATE TABLE IF NOT EXISTS stories (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  resume_id uuid REFERENCES resumes(id) ON DELETE SET NULL,
  name text NOT NULL,
  tags text[] NOT NULL DEFAULT '{}',
  situation text NOT NULL DEFAULT '',
  action text NOT NULL DEFAULT '',
  result text NOT NULL DEFAULT '',
  forbidden text NOT NULL DEFAULT '',
  signals text[] NOT NULL DEFAULT '{}',
  ordinal int NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS stories_user_idx ON stories (user_id, ordinal, updated_at DESC);

ALTER TABLE stories ADD COLUMN IF NOT EXISTS rehearsed_at timestamptz;
ALTER TABLE stories ADD COLUMN IF NOT EXISTS rehearsal_count int NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS billing_plans (
  id text PRIMARY KEY,
  name text NOT NULL,
  kind text NOT NULL,
  price_cents int NOT NULL,
  currency text NOT NULL DEFAULT 'usd',
  interval text NOT NULL DEFAULT 'month',
  blurb text NOT NULL DEFAULT '',
  features jsonb NOT NULL DEFAULT '[]',
  stripe_product_id text,
  stripe_price_id text,
  active boolean NOT NULL DEFAULT true,
  ordinal int NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  plan_id text NOT NULL REFERENCES billing_plans(id),
  status text NOT NULL DEFAULT 'inactive',
  stripe_customer_id text,
  stripe_subscription_id text,
  stripe_checkout_id text,
  current_period_end timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS subscriptions_user_idx ON subscriptions (user_id);

ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS llm_provider text;
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS llm_key_cipher text;
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS llm_key_iv text;
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS llm_key_tag text;
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS llm_base_url text;
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS llm_key_last4 text;

CREATE TABLE IF NOT EXISTS answer_modes (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slug text NOT NULL DEFAULT '',
  name text NOT NULL,
  instructions text NOT NULL DEFAULT '',
  builtin boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS answer_modes_user_slug_idx
  ON answer_modes (user_id, slug)
  WHERE slug <> '';

CREATE INDEX IF NOT EXISTS answer_modes_user_idx
  ON answer_modes (user_id, builtin DESC, created_at ASC);

ALTER TABLE user_profiles
  ADD COLUMN IF NOT EXISTS active_mode_id uuid REFERENCES answer_modes(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS mode_documents (
  id uuid PRIMARY KEY,
  mode_id uuid NOT NULL REFERENCES answer_modes(id) ON DELETE CASCADE,
  title text NOT NULL,
  raw_text text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mode_documents_mode_idx
  ON mode_documents (mode_id, created_at DESC);
