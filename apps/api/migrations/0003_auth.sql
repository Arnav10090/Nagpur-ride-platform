CREATE TABLE "User" (id uuid PRIMARY KEY, phone text NOT NULL UNIQUE CHECK (phone ~ '^\+91[6-9][0-9]{9}$'),
  role text NOT NULL CHECK (role IN ('RIDER','DRIVER','SUPPORT','OPS_ADMIN','FINANCE_ADMIN','SUPER_ADMIN')),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','SUSPENDED')), "createdAt" timestamptz NOT NULL DEFAULT now());

-- Only a hash of the OTP is stored; one live challenge per phone.
CREATE TABLE "OtpChallenge" (phone text PRIMARY KEY, hash text NOT NULL, "expiresAt" timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0, used boolean NOT NULL DEFAULT false, "createdAt" timestamptz NOT NULL);

-- Only a hash of the refresh token is stored.
CREATE TABLE "Session" ("tokenHash" text PRIMARY KEY, "userId" uuid NOT NULL REFERENCES "User"(id),
  revoked boolean NOT NULL DEFAULT false, "expiresAt" timestamptz NOT NULL, "createdAt" timestamptz NOT NULL DEFAULT now());
CREATE INDEX session_user_idx ON "Session" ("userId");

-- A user's role may never be changed through ordinary updates
CREATE FUNCTION user_role_guard() RETURNS trigger AS $$
BEGIN IF NEW.role <> OLD.role OR NEW.phone <> OLD.phone THEN RAISE EXCEPTION 'user role/phone are immutable' USING ERRCODE='23514'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql;
CREATE TRIGGER user_role_guard_trg BEFORE UPDATE ON "User" FOR EACH ROW EXECUTE FUNCTION user_role_guard();

-- Outbox: retry scheduling for the publisher
-- NULL = due immediately; set only when a failed delivery is scheduled for retry (so DB/app clock skew cannot hide new events)
ALTER TABLE "OutboxEvent" ADD COLUMN "availableAt" timestamptz;
DROP INDEX outbox_pending_idx;
CREATE INDEX outbox_pending_idx ON "OutboxEvent" (seq) WHERE "deliveryStatus" = 'PENDING';
