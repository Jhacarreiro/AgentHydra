CREATE TABLE people_users (
  sub text PRIMARY KEY,
  training_use boolean NOT NULL DEFAULT true,
  terms_version text,
  terms_accepted_at timestamptz,
  training_use_off_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE TABLE people_docs (
  scope text NOT NULL,
  doc_id text NOT NULL,
  version integer NOT NULL CHECK (version >= 1),
  body bytea NOT NULL,
  nonce bytea NOT NULL,
  key_id integer NOT NULL,
  bytes integer NOT NULL CHECK (bytes >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  PRIMARY KEY (scope, doc_id)
);

CREATE TABLE people_doc_versions (
  scope text NOT NULL,
  doc_id text NOT NULL,
  version integer NOT NULL CHECK (version >= 1),
  body bytea NOT NULL,
  nonce bytea NOT NULL,
  key_id integer NOT NULL,
  bytes integer NOT NULL CHECK (bytes >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  PRIMARY KEY (scope, doc_id, version)
);

CREATE TABLE people_audit (
  id bigserial PRIMARY KEY,
  ts timestamptz NOT NULL DEFAULT now(),
  sub_hash text NOT NULL,
  action text NOT NULL,
  doc_id text,
  ip_hash text,
  request_id text
);
