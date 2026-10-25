-- Reconciliation findings can be resolved (once) with a named person and a written note; history is never reopened or deleted.
ALTER TABLE "ReconciliationFinding" ADD COLUMN "resolvedBy" text, ADD COLUMN "resolvedNote" text, ADD COLUMN "resolvedAt" timestamptz;
ALTER TABLE "ReconciliationFinding" ADD CONSTRAINT finding_resolution_complete
  CHECK ((status = 'OPEN' AND "resolvedBy" IS NULL AND "resolvedAt" IS NULL) OR (status = 'RESOLVED' AND "resolvedBy" IS NOT NULL AND "resolvedAt" IS NOT NULL AND length("resolvedNote") >= 5));
CREATE FUNCTION finding_guard() RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'RESOLVED' AND (NEW.status <> 'RESOLVED' OR NEW."resolvedNote" IS DISTINCT FROM OLD."resolvedNote" OR NEW."resolvedBy" IS DISTINCT FROM OLD."resolvedBy") THEN
    RAISE EXCEPTION 'a resolved finding cannot be reopened or edited' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER finding_guard_trg BEFORE UPDATE ON "ReconciliationFinding" FOR EACH ROW EXECUTE FUNCTION finding_guard();
CREATE INDEX audit_at_idx ON "AuditLog" ("at");
