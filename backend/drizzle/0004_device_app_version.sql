-- The gate app build each phone last reported (x-app-version), shown on the
-- admin Devices page so a phone still on an old APK can be found and updated.
-- "legacy" for builds from before the header existed; NULL for web browsers
-- and for phones not seen since this column was added.
ALTER TABLE devices ADD COLUMN app_version text;
