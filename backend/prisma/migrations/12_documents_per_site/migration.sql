-- A document belongs to a site, not to the company as a whole.
--
-- A labour licence is granted for a particular project, and it is that project
-- that is exposed when it lapses — so the document expires against a site, is
-- chased for that site, and is filed under it rather than in one company-wide
-- pile that nobody can tell apart.
--
-- NOT NULL with no default and no backfill, which is only safe because the
-- table is empty: the feature shipped yesterday and nothing has been uploaded
-- yet. Checked against the live database before writing this.
--
-- ON DELETE CASCADE matches how the site's other records behave (its safety
-- entries and assignments go the same way): clearing out a finished project
-- should not leave its paperwork behind with nothing to point at.

ALTER TABLE "company_documents"
    ADD COLUMN "site_id" UUID NOT NULL;

ALTER TABLE "company_documents"
    ADD CONSTRAINT "company_documents_site_id_fkey"
    FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The documents page lists one site at a time.
CREATE INDEX "company_documents_site_id_idx" ON "company_documents"("site_id");
