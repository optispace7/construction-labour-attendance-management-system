import { and, eq, isNull, ne, or } from 'drizzle-orm';
import { createTestD1, insert } from '../../../test/d1-harness';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from '../../infra/d1/schema.generated';
import { companyDocuments } from '../../infra/d1/schema.generated';

/**
 * The reminder claim, against a real SQLite.
 *
 * Two replicas host this monitor, so "did my update touch the row" is the only
 * thing standing between one reminder and two. It rests on the change count a
 * conditional UPDATE reports, which is worth checking rather than assuming.
 */
describe('document expiry claim', () => {
  const seed = async () => {
    const t = await createTestD1();
    const db = drizzle(t.db, { schema });
    const now = Date.now();
    await insert(t.db, 'organizations', {
      id: 'org1', name: 'X', code: 'X', timezone: 'Asia/Kolkata',
      is_active: 1, logo_scale: 1, created_at: now, updated_at: now,
    });
    await insert(t.db, 'sites', {
      id: 'site1', organization_id: 'org1', name: 'Tower A', code: 'TA',
      timezone: 'Asia/Kolkata', is_active: 1, created_at: now, updated_at: now,
    });
    await insert(t.db, 'company_documents', {
      id: 'd1', organization_id: 'org1', site_id: 'site1', name: 'Labour licence',
      file_name: 'l.pdf', mime_type: 'application/pdf', size_bytes: 10,
      valid_until: '2026-12-31', remind_days_before: 30,
      created_at: now, updated_at: now,
    });
    return { t, db };
  };

  /** The monitor's claim, verbatim. */
  const claim = async (db: ReturnType<typeof drizzle>, validUntil: string) => {
    const col = companyDocuments.reminderSentFor;
    const res = (await db
      .update(companyDocuments)
      .set({ reminderSentFor: validUntil })
      .where(
        and(eq(companyDocuments.id, 'd1'), or(isNull(col), ne(col, validUntil))),
      )) as unknown as { meta?: { changes?: number } };
    return (res?.meta?.changes ?? 0) > 0;
  };

  it('claims once, and refuses the second replica', async () => {
    const { t, db } = await seed();
    try {
      expect(await claim(db, '2026-12-31')).toBe(true);
      // The second call finds the date already written, so it sends nothing.
      expect(await claim(db, '2026-12-31')).toBe(false);
    } finally {
      await t.dispose();
    }
  });

  it('arms again when the document is renewed to a new date', async () => {
    const { t, db } = await seed();
    try {
      expect(await claim(db, '2026-12-31')).toBe(true);
      // Renewed: a different validity is a different reminder.
      expect(await claim(db, '2027-12-31')).toBe(true);
    } finally {
      await t.dispose();
    }
  });
});
