CREATE TABLE "Payment" (
  id uuid PRIMARY KEY, "rideId" uuid NOT NULL UNIQUE REFERENCES "Ride"(id),
  "amountMinor" integer NOT NULL CHECK ("amountMinor" > 0),
  status text NOT NULL CHECK (status IN ('PENDING','REQUIRES_ACTION','SUCCEEDED','FAILED','CANCELLED','PARTIALLY_REFUNDED','REFUNDED')),
  attempt integer NOT NULL DEFAULT 1 CHECK (attempt >= 1), "providerRef" text, intent jsonb,
  "refundedMinor" integer NOT NULL DEFAULT 0, "createdAt" timestamptz NOT NULL, "updatedAt" timestamptz NOT NULL,
  CHECK ("refundedMinor" >= 0 AND "refundedMinor" <= "amountMinor"),                                  -- can never refund more than was paid
  CHECK (status IN ('PENDING','FAILED','CANCELLED') OR "providerRef" IS NOT NULL));                   -- a live/captured payment always names its provider reference
CREATE INDEX payment_stale_idx ON "Payment" (status, "updatedAt");

-- every provider reference ever issued for a payment, so late events for an OLD attempt can still be matched
CREATE TABLE "PaymentAttempt" ("providerRef" text PRIMARY KEY, "paymentId" uuid NOT NULL REFERENCES "Payment"(id), attempt integer NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(), UNIQUE ("paymentId", attempt));

-- AC-06: one row per provider event id, ever
CREATE TABLE "PaymentEvent" (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), provider text NOT NULL, "providerEventId" text NOT NULL, type text NOT NULL,
  "providerRef" text NOT NULL, payload jsonb NOT NULL, outcome text NOT NULL DEFAULT 'RECEIVED', "receivedAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payment_event_provider_unique UNIQUE (provider, "providerEventId"));

CREATE TABLE "Refund" (
  id uuid PRIMARY KEY, "paymentId" uuid NOT NULL REFERENCES "Payment"(id), "providerRef" text NOT NULL,
  "amountMinor" integer NOT NULL CHECK ("amountMinor" > 0), reason text NOT NULL CHECK (length(reason) >= 3),
  kind text NOT NULL CHECK (kind IN ('CUSTOMER','DUPLICATE_CAPTURE')), status text NOT NULL CHECK (status IN ('REQUESTED','SUCCEEDED','FAILED')),
  "providerRefundRef" text, "requestedBy" text NOT NULL, "createdAt" timestamptz NOT NULL, "updatedAt" timestamptz NOT NULL DEFAULT now());
CREATE INDEX refund_payment_idx ON "Refund" ("paymentId");
-- at most one automatic refund per duplicate capture
CREATE UNIQUE INDEX refund_one_dup_per_capture ON "Refund" ("providerRef") WHERE kind = 'DUPLICATE_CAPTURE';

CREATE TABLE "ReconciliationFinding" (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), kind text NOT NULL, "providerRef" text NOT NULL, details jsonb NOT NULL,
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','RESOLVED')), "createdAt" timestamptz NOT NULL DEFAULT now(), UNIQUE (kind, "providerRef"));

-- Payment money fields are protected at the database layer
CREATE FUNCTION payment_guard() RETURNS trigger AS $$
BEGIN
  IF NEW."amountMinor" <> OLD."amountMinor" THEN RAISE EXCEPTION 'payment amount is immutable' USING ERRCODE = '23514'; END IF;
  IF NEW."rideId" <> OLD."rideId" THEN RAISE EXCEPTION 'payment ride is immutable' USING ERRCODE = '23514'; END IF;
  IF OLD.status IN ('REFUNDED') AND NEW.status <> OLD.status THEN RAISE EXCEPTION 'refunded payment is final' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER payment_guard_trg BEFORE UPDATE ON "Payment" FOR EACH ROW EXECUTE FUNCTION payment_guard();

CREATE TRIGGER payment_event_no_delete BEFORE DELETE ON "PaymentEvent" FOR EACH ROW EXECUTE FUNCTION append_only_guard();
CREATE TRIGGER finding_no_delete BEFORE DELETE ON "ReconciliationFinding" FOR EACH ROW EXECUTE FUNCTION append_only_guard();
