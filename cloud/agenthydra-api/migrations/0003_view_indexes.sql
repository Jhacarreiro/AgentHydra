CREATE INDEX people_docs_updated_idx ON people_docs (scope, updated_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX people_audit_ts_idx ON people_audit (ts);
CREATE INDEX people_audit_sub_idx ON people_audit (sub_hash, ts);

-- Opted-out and deleted users never appear. user_ref is a stable pseudonym; no email exists here.
CREATE VIEW training_eligible AS
SELECT encode(sha256(convert_to(u.sub, 'UTF8')), 'hex') AS user_ref,
       d.doc_id, d.version, d.body, d.nonce, d.key_id, d.updated_at
FROM people_docs d
JOIN people_users u ON d.scope = 'user:' || u.sub
WHERE u.training_use AND u.deleted_at IS NULL AND d.deleted_at IS NULL;
