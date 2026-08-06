-- Keep the name of a device that gets deleted.
--
-- A tap records which device took it through device_id, and that foreign key is
-- ON DELETE SET NULL: deleting a device blanks the column on every punch it ever
-- recorded. Until now delete was simply refused once a device had marked
-- attendance, which left sites unable to clear out a tablet they had retired.
--
-- The name is copied onto the punches at the moment of deletion instead, so the
-- device row can go while "which device took this" survives it. Only written
-- when a device is deleted — while a device still exists its own row is the
-- answer, and denormalising on every tap would cost a lookup on the one call
-- that must never be slow.

ALTER TABLE "attendance_taps" ADD COLUMN "device_label" TEXT;
