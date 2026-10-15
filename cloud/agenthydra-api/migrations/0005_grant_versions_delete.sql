-- DELETE /v1/me hard-deletes a user's version rows too (RLS still limits it to their own scope).
GRANT DELETE ON people_doc_versions TO agenthydra_app;
