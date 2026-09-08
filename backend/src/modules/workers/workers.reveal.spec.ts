import { WorkersController } from './workers.controller';
import { UserRole } from '../../common/enums';

/**
 * The reveal gate must read the role→permission table, not a hardcoded list of
 * role names: the Safety Officer (SUPERVISOR) holds WORKER_VIEW_SENSITIVE and
 * was silently served masked data by an earlier `role !== SITE_ADMIN` check.
 */
function setup() {
  const workers = { get: jest.fn().mockResolvedValue({ id: 'w1' }) };
  const controller = new WorkersController(workers as any);
  return { controller, workers };
}

const asUser = (role: UserRole) => ({ userId: 'u1', organizationId: 'org-1', role }) as any;

describe('WorkersController reveal gating', () => {
  it.each<UserRole>(['SUPER_ADMIN', 'SITE_ADMIN', 'SUPERVISOR'])(
    'reveals to %s, who holds the sensitive permission',
    (role) => {
      const { controller, workers } = setup();
      controller.get(asUser(role), 'w1', 'true');
      expect(workers.get).toHaveBeenCalledWith(expect.anything(), 'w1', true);
    },
  );

  it('masks for a role without the sensitive permission', () => {
    const { controller, workers } = setup();
    controller.get(asUser('WATCHMAN'), 'w1', 'true');
    expect(workers.get).toHaveBeenCalledWith(expect.anything(), 'w1', false);
  });

  it('masks when reveal was not asked for', () => {
    const { controller, workers } = setup();
    controller.get(asUser('SUPERVISOR'), 'w1', undefined);
    expect(workers.get).toHaveBeenCalledWith(expect.anything(), 'w1', false);
  });
});
