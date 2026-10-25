-- Rating table: riders rate drivers and drivers rate riders after ride completion.
-- One rating per role per ride is enforced by the unique constraint.

CREATE TABLE "Rating" (
  id UUID PRIMARY KEY,
  "rideId" UUID NOT NULL REFERENCES "Ride"(id),
  "fromUserId" UUID NOT NULL,
  "toUserId" UUID NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('RIDER', 'DRIVER')),
  stars INT NOT NULL CHECK (stars BETWEEN 1 AND 5),
  comment TEXT,
  "createdAt" BIGINT NOT NULL
);

-- One rating per role per ride (rider can rate driver, driver can rate rider, but each only once)
CREATE UNIQUE INDEX "uq_rating_ride_role" ON "Rating"("rideId", role);

-- Fast lookup for computing a user's average rating
CREATE INDEX "idx_rating_toUser" ON "Rating"("toUserId");
