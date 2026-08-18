import 'reflect-metadata';
import { UserRole } from '@prisma/client';
import { CompanyDocumentsController } from './company-documents.controller';
import { PERMISSIONS_KEY } from '../../common/rbac/rbac.decorators';
import { Permission, roleHasPermission } from '../../common/rbac/permissions';

type Route = keyof CompanyDocumentsController;

/**
 * What PolicyGuard would demand of a route: the handler's own decorator, or
 * the controller's when it has none. Read the same way round as
 * `reflector.getAllAndOverride([handler, class])`, so this asserts the wiring
 * the guard actually follows rather than a copy of it.
 */
function required(route: Route): Permission[] {
  const handler = CompanyDocumentsController.prototype[route] as unknown as object;
  return (
    (Reflect.getMetadata(PERMISSIONS_KEY, handler) as Permission[] | undefined) ??
    (Reflect.getMetadata(PERMISSIONS_KEY, CompanyDocumentsController) as Permission[])
  );
}

const allows = (role: UserRole, route: Route) =>
  required(route).every((p) => roleHasPermission(role, p));

const READS: Route[] = ['list', 'file'];
const WRITES: Route[] = ['create', 'update', 'remove'];

describe('company documents permissions', () => {
  it('gates reading on DOCUMENT_VIEW and every change on SETTINGS_MANAGE', () => {
    for (const route of READS) expect(required(route)).toEqual([Permission.DOCUMENT_VIEW]);
    for (const route of WRITES) expect(required(route)).toEqual([Permission.SETTINGS_MANAGE]);
  });

  it('lets the Safety Officer read the paperwork', () => {
    for (const route of READS) expect(allows('SUPERVISOR', route)).toBe(true);
  });

  it('does not let the Safety Officer file, rename or delete it', () => {
    for (const route of WRITES) expect(allows('SUPERVISOR', route)).toBe(false);
  });

  it('leaves the two admin roles in charge of all of it', () => {
    for (const role of ['SUPER_ADMIN', 'SITE_ADMIN'] as const) {
      for (const route of [...READS, ...WRITES]) expect(allows(role, route)).toBe(true);
    }
  });

  it('keeps the watchman out entirely', () => {
    for (const route of [...READS, ...WRITES]) expect(allows('WATCHMAN', route)).toBe(false);
  });

  it('closes a route that forgets its own decorator', () => {
    // The class carries SETTINGS_MANAGE precisely so an undecorated route
    // inherits the stricter rule instead of the looser one.
    expect(Reflect.getMetadata(PERMISSIONS_KEY, CompanyDocumentsController)).toEqual([
      Permission.SETTINGS_MANAGE,
    ]);
  });
});
