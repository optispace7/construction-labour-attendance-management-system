-- Work e-mail on a person record.
--
-- Staff ID cards print a "Mail Id" line, and nothing on the worker record held
-- an address for it — the only e-mail we stored belonged to the login user, who
-- is a different record from the staff member the card is issued to. Nullable
-- and untyped at the database level: workers and visitors never fill it, and the
-- format is validated in the DTO.

ALTER TABLE "workers" ADD COLUMN "email" TEXT;
