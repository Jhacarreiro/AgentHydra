GRANT SELECT, INSERT, UPDATE, DELETE ON people_docs TO people_app;
GRANT SELECT, INSERT ON people_doc_versions TO people_app;
GRANT SELECT, INSERT, UPDATE ON people_users TO people_app;
GRANT INSERT ON people_audit TO people_app;
GRANT USAGE ON SEQUENCE people_audit_id_seq TO people_app;

GRANT SELECT ON training_eligible TO people_export;

GRANT SELECT ON people_docs, people_doc_versions, people_users, people_audit TO people_backup;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO people_backup;
