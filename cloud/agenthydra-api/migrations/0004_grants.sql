GRANT SELECT, INSERT, UPDATE, DELETE ON people_docs TO agenthydra_app;
GRANT SELECT, INSERT ON people_doc_versions TO agenthydra_app;
GRANT SELECT, INSERT, UPDATE ON people_users TO agenthydra_app;
GRANT INSERT ON people_audit TO agenthydra_app;
GRANT USAGE ON SEQUENCE people_audit_id_seq TO agenthydra_app;

GRANT SELECT ON training_eligible TO agenthydra_export;

GRANT SELECT ON people_docs, people_doc_versions, people_users, people_audit, schema_migrations TO agenthydra_backup;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO agenthydra_backup;
