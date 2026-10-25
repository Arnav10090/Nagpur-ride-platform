-- Invariants enforced by the database itself, independent of application code (PRD 3, 7.3, 8.2, 11.4).

-- AC-01: at most one ACTIVE assignment per ride, and per driver
CREATE UNIQUE INDEX ride_assignment_one_active_per_ride   ON "RideAssignment" ("rideId")   WHERE status = 'ACTIVE';
CREATE UNIQUE INDEX ride_assignment_one_active_per_driver ON "RideAssignment" ("driverId") WHERE status = 'ACTIVE';
-- A ride has at most one live offer; offer order is unique; a driver is never re-offered the same attempt
CREATE UNIQUE INDEX ride_offer_one_pending_per_ride ON "RideOffer" ("rideId") WHERE status = 'PENDING';
CREATE UNIQUE INDEX ride_offer_sequence_unique      ON "RideOffer" ("dispatchAttemptId", "sequenceNumber");
CREATE UNIQUE INDEX ride_offer_driver_once          ON "RideOffer" ("dispatchAttemptId", "driverId");
-- AC-03: idempotent booking
CREATE UNIQUE INDEX idempotency_scope_key ON "IdempotencyRecord" (scope, key);

-- Ride state machine at the database layer: legal transitions only, terminal states final, version advances by 1
CREATE FUNCTION ride_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.status <> OLD.status THEN
    IF NOT ((OLD.status || '>' || NEW.status) = ANY (ARRAY[
      'REQUESTED>SEARCHING','REQUESTED>CANCELLED',
      'SEARCHING>DRIVER_ASSIGNED','SEARCHING>CANCELLED','SEARCHING>EXPIRED',
      'DRIVER_ASSIGNED>DRIVER_ARRIVING','DRIVER_ASSIGNED>CANCELLED',
      'DRIVER_ARRIVING>DRIVER_ARRIVED','DRIVER_ARRIVING>CANCELLED',
      'DRIVER_ARRIVED>IN_PROGRESS','DRIVER_ARRIVED>CANCELLED',
      'IN_PROGRESS>COMPLETED'])) THEN
      RAISE EXCEPTION 'illegal ride transition % -> %', OLD.status, NEW.status USING ERRCODE = '23514';
    END IF;
    IF NEW."stateVersion" <> OLD."stateVersion" + 1 THEN
      RAISE EXCEPTION 'stateVersion must advance by exactly 1' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF OLD.status IN ('COMPLETED','CANCELLED','EXPIRED') AND NEW."driverId" IS DISTINCT FROM OLD."driverId" THEN
    RAISE EXCEPTION 'terminal ride is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD."finalFareMinor" IS NOT NULL AND NEW."finalFareMinor" IS DISTINCT FROM OLD."finalFareMinor" THEN
    RAISE EXCEPTION 'final fare is immutable once set' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER ride_guard_trg BEFORE UPDATE ON "Ride" FOR EACH ROW EXECUTE FUNCTION ride_guard();

-- Financial and audit history is append-only
CREATE FUNCTION append_only_guard() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '23514'; END $$ LANGUAGE plpgsql;
CREATE TRIGGER ledger_entry_append_only BEFORE UPDATE OR DELETE ON "LedgerEntry"       FOR EACH ROW EXECUTE FUNCTION append_only_guard();
CREATE TRIGGER ledger_tx_append_only    BEFORE UPDATE OR DELETE ON "LedgerTransaction" FOR EACH ROW EXECUTE FUNCTION append_only_guard();
CREATE TRIGGER audit_append_only        BEFORE UPDATE OR DELETE ON "AuditLog"          FOR EACH ROW EXECUTE FUNCTION append_only_guard();

-- Every ledger transaction must balance at commit (deferred so all lines can be inserted first)
CREATE FUNCTION ledger_check_balanced() RETURNS trigger AS $$
BEGIN
  IF (SELECT COALESCE(SUM(CASE direction WHEN 'DEBIT' THEN "amountMinor" ELSE -"amountMinor" END), 0)
        FROM "LedgerEntry" WHERE "transactionId" = NEW."transactionId") <> 0 THEN
    RAISE EXCEPTION 'unbalanced ledger transaction %', NEW."transactionId" USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER ledger_balanced AFTER INSERT ON "LedgerEntry"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger_check_balanced();
