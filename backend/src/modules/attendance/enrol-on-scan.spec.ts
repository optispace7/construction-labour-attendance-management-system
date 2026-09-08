import { AttendanceService } from './attendance.service';
import { drizzleDouble } from '../../../test/drizzle-double';
import { workerSiteAssignments } from '../../infra/d1/schema.generated';

/**
 * Scanning somebody in at a site puts them on that site's list.
 *
 * The bug this closes: which site a person belongs to is only recorded when
 * somebody fills the optional Site field at registration. A worker registered
 * without one belongs to no site, and the gate resolves a badge against the
 * whole organization — so he was scanned in, appeared in attendance, and was
 * still missing from the Safety Officer's list, whose search box only filters
 * what that list already loaded. He was also missing from the offline cache
 * that same list warms, so he could be scanned with signal and not at all
 * without it.
 */

const SITE = 'site-1';
const WORKER = 'worker-1';

/** Reach the private helper without pretending the whole tap path is here. */
function enrol(svc: AttendanceService, workerId: string, siteId: string): Promise<void> {
  return (
    svc as unknown as {
      ensureSiteAssignment(w: string, s: string): Promise<void>;
    }
  ).ensureSiteAssignment(workerId, siteId);
}

function build(existing: { siteId: string }[]) {
  const db = drizzleDouble([[workerSiteAssignments, existing]]);
  const svc = Object.create(AttendanceService.prototype) as AttendanceService;
  Object.defineProperty(svc, 'd1', { value: { db: db.db } });
  Object.defineProperty(svc, 'logger', { value: { log: jest.fn(), warn: jest.fn() } });
  // The values handed to the insert — what the assertions below are about.
  const create = db.db.values;
  return { svc, create, db };
}

describe('AttendanceService.ensureSiteAssignment', () => {
  it('enrols a worker who belongs to no site', async () => {
    const { svc, create } = build([]);

    await enrol(svc, WORKER, SITE);

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ workerId: WORKER, siteId: SITE, isPrimary: true }),
    );
  });

  it('does nothing when they already belong to that site', async () => {
    const { svc, create } = build([{ siteId: SITE }]);
    await enrol(svc, WORKER, SITE);
    expect(create).not.toHaveBeenCalled();
  });

  it('adds a second site without demoting the first', async () => {
    const { svc, create } = build([{ siteId: 'somewhere-else' }]);

    await enrol(svc, WORKER, SITE);

    // Working a day at another site is an addition, not a correction of where
    // they normally are.
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ isPrimary: false }));
  });

  it('never lets a failed enrolment break the scan', async () => {
    const { svc, db } = build([]);
    db.db.from.mockImplementation(() => {
      throw new Error('db down');
    });
    // The punch is the thing that must not fail; the list can catch up later.
    await expect(enrol(svc, WORKER, SITE)).resolves.toBeUndefined();
  });
});
