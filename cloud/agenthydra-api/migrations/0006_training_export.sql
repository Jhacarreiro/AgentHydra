-- The export decrypts per user, so the view carries sub (read in memory, never written out).
-- Terms must be accepted; users who opted out or were deleted never appear.
DROP VIEW training_eligible;
CREATE VIEW training_eligible AS
SELECT encode(sha256(convert_to(u.sub, 'UTF8')), 'hex') AS user_ref,
       u.sub,
       d.doc_id, d.version, d.body, d.nonce, d.key_id, d.updated_at
FROM people_docs d
JOIN people_users u ON d.scope = 'user:' || u.sub
WHERE u.training_use
  AND u.terms_version IS NOT NULL
  AND u.terms_accepted_at IS NOT NULL
  AND u.deleted_at IS NULL
  AND d.deleted_at IS NULL;
GRANT SELECT ON training_eligible TO agenthydra_export;

GRANT INSERT ON people_audit TO agenthydra_export;
GRANT USAGE ON SEQUENCE people_audit_id_seq TO agenthydra_export;
ALTER TABLE people_audit ADD COLUMN IF NOT EXISTS detail jsonb;
