ALTER TABLE people_docs ENABLE ROW LEVEL SECURITY;
ALTER TABLE people_docs FORCE ROW LEVEL SECURITY;
-- current_setting(..., true) is NULL when unset, so an unscoped session sees nothing.
CREATE POLICY people_docs_scope ON people_docs
  USING (scope = current_setting('people.scope', true))
  WITH CHECK (scope = current_setting('people.scope', true));
-- The owner role (deploy only) feeds the training_eligible view; it never serves requests.
CREATE POLICY people_docs_owner_read ON people_docs FOR SELECT TO agenthydra_owner USING (true);

ALTER TABLE people_doc_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE people_doc_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY people_versions_scope ON people_doc_versions
  USING (scope = current_setting('people.scope', true))
  WITH CHECK (scope = current_setting('people.scope', true));
