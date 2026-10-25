DO $$ BEGIN CREATE EXTENSION IF NOT EXISTS postgis; EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'PostGIS not available — spatial queries will not work, but plain lat/lng columns are fine'; END $$;

CREATE TABLE "FareQuote" (
  id uuid PRIMARY KEY, "riderId" text NOT NULL, "zoneId" text NOT NULL, category text NOT NULL,
  pickup jsonb NOT NULL, destination jsonb NOT NULL, breakdown jsonb NOT NULL,
  "totalMinor" integer NOT NULL CHECK ("totalMinor" > 0), currency text NOT NULL DEFAULT 'INR' CHECK (currency = 'INR'),
  "expiresAt" timestamptz NOT NULL, "createdAt" timestamptz NOT NULL DEFAULT now());

CREATE TABLE "Ride" (
  id uuid PRIMARY KEY, "riderId" text NOT NULL, "driverId" text,
  status text NOT NULL CHECK (status IN ('REQUESTED','SEARCHING','DRIVER_ASSIGNED','DRIVER_ARRIVING','DRIVER_ARRIVED','IN_PROGRESS','COMPLETED','CANCELLED','EXPIRED')),
  "stateVersion" integer NOT NULL CHECK ("stateVersion" >= 1),
  "zoneId" text NOT NULL, category text NOT NULL, "pickupLat" double precision NOT NULL, "pickupLng" double precision NOT NULL,
  "fareQuoteId" uuid REFERENCES "FareQuote"(id), "paymentMethod" text CHECK ("paymentMethod" IN ('CASH','UPI')),
  "finalFareMinor" integer CHECK ("finalFareMinor" > 0), "createdAt" timestamptz NOT NULL DEFAULT now(),
  CHECK (status NOT IN ('DRIVER_ASSIGNED','DRIVER_ARRIVING','DRIVER_ARRIVED','IN_PROGRESS','COMPLETED') OR "driverId" IS NOT NULL));
CREATE INDEX ride_rider_idx ON "Ride" ("riderId", "createdAt");
CREATE INDEX ride_status_idx ON "Ride" (status);

CREATE TABLE "RideAssignment" (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "rideId" uuid NOT NULL REFERENCES "Ride"(id), "driverId" text NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','ENDED')), "createdAt" timestamptz NOT NULL DEFAULT now(), "endedAt" timestamptz);

CREATE TABLE "RideOffer" (
  id uuid PRIMARY KEY, "rideId" uuid NOT NULL REFERENCES "Ride"(id), "driverId" text NOT NULL,
  "sequenceNumber" integer NOT NULL, "dispatchAttemptId" text NOT NULL,
  status text NOT NULL CHECK (status IN ('PENDING','ACCEPTED','REJECTED','EXPIRED','INVALIDATED')),
  "createdAt" timestamptz NOT NULL, "expiresAt" timestamptz NOT NULL, "respondedAt" timestamptz, CHECK ("expiresAt" > "createdAt"));
CREATE INDEX ride_offer_driver_idx ON "RideOffer" ("driverId", status);

CREATE TABLE "RideEvent" (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "rideId" uuid NOT NULL REFERENCES "Ride"(id),
  type text NOT NULL, "stateVersion" integer NOT NULL, payload jsonb NOT NULL DEFAULT '{}', "createdAt" timestamptz NOT NULL DEFAULT now());

CREATE TABLE "DriverPresence" (
  "driverId" text PRIMARY KEY, approved boolean NOT NULL, online boolean NOT NULL, "vehicleCategory" text NOT NULL, "zoneId" text NOT NULL,
  lat double precision NOT NULL CHECK (lat BETWEEN -90 AND 90), lng double precision NOT NULL CHECK (lng BETWEEN -180 AND 180),
  "lastLocationAt" timestamptz NOT NULL, "activeRideId" uuid REFERENCES "Ride"(id));
-- PostGIS spatial index (requires PostGIS extension):
-- ALTER TABLE "DriverPresence" ADD COLUMN point geography(Point,4326) GENERATED ALWAYS AS (ST_SetSRID(ST_MakePoint(lng, lat), 4326)::geography) STORED;
-- CREATE INDEX driver_presence_gist ON "DriverPresence" USING GIST (point);

CREATE TABLE "DriverProfile" (
  "userId" text PRIMARY KEY, verification text NOT NULL CHECK (verification IN ('PENDING','APPROVED','REJECTED')),
  category text NOT NULL, "registrationNumber" text NOT NULL, "lastSeq" integer NOT NULL DEFAULT -1,
  CONSTRAINT driver_registration_unique UNIQUE ("registrationNumber"));

CREATE TABLE "IdempotencyRecord" (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), scope text NOT NULL, key text NOT NULL,
  "resourceId" text NOT NULL, "createdAt" timestamptz NOT NULL DEFAULT now());

CREATE TABLE "OutboxEvent" (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "aggregateId" text NOT NULL, type text NOT NULL, payload jsonb NOT NULL,
  "deliveryStatus" text NOT NULL DEFAULT 'PENDING' CHECK ("deliveryStatus" IN ('PENDING','DELIVERED','FAILED')),
  attempts integer NOT NULL DEFAULT 0, "createdAt" timestamptz NOT NULL DEFAULT now(), seq bigserial);
CREATE INDEX outbox_pending_idx ON "OutboxEvent" ("deliveryStatus", seq);

CREATE TABLE "LedgerTransaction" (id text PRIMARY KEY, "createdAt" timestamptz NOT NULL DEFAULT now());
CREATE TABLE "LedgerEntry" (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "transactionId" text NOT NULL REFERENCES "LedgerTransaction"(id),
  account text NOT NULL, direction text NOT NULL CHECK (direction IN ('DEBIT','CREDIT')),
  "amountMinor" integer NOT NULL CHECK ("amountMinor" > 0), "createdAt" timestamptz NOT NULL DEFAULT now());
CREATE INDEX ledger_tx_idx ON "LedgerEntry" ("transactionId");
CREATE INDEX ledger_account_idx ON "LedgerEntry" (account);

CREATE TABLE "AuditLog" (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "actorId" text NOT NULL, action text NOT NULL, "targetId" text NOT NULL,
  reason text NOT NULL, "before" jsonb, "after" jsonb, "at" timestamptz NOT NULL, seq bigserial);
