-- SOS incident table: riders and drivers can trigger SOS during active rides.
-- Ops staff can acknowledge and resolve incidents.

CREATE TABLE "SosIncident" (
  id UUID PRIMARY KEY,
  "rideId" UUID NOT NULL REFERENCES "Ride"(id),
  "reporterId" UUID NOT NULL,
  "reporterRole" TEXT NOT NULL CHECK ("reporterRole" IN ('RIDER', 'DRIVER')),
  lat DOUBLE PRECISION,
  lng DOUBLE PRECISION,
  description TEXT NOT NULL DEFAULT 'SOS triggered',
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'ACKNOWLEDGED', 'RESOLVED')),
  "createdAt" BIGINT NOT NULL,
  "resolvedAt" BIGINT,
  "resolvedBy" UUID,
  "resolvedNote" TEXT
);

CREATE INDEX "idx_sos_status" ON "SosIncident"(status);
CREATE INDEX "idx_sos_ride" ON "SosIncident"("rideId");
