import 'reflect-metadata';
import { UserRole } from '@prisma/client';
import { SafetyController } from './safety.controller';
import { PERMISSIONS_KEY } from '../../common/rbac/rbac.decorators';
import { Permission, roleHasPermission } from '../../common/rbac/permissions';
import { DEFAULT_WASTE_TYPES, METRIC_CATALOG, WASTE_METRIC } from './safety.metrics';

type Route = keyof SafetyController;

/** What PolicyGuard would demand of a route — handler first, then the class. */
function required(route: Route): Permission[] {
  const handler = SafetyController.prototype[route] as unknown as object;
  return (
    (Reflect.getMetadata(PERMISSIONS_KEY, handler) as Permission[] | undefined) ??
    (Reflect.getMetadata(PERMISSIONS_KEY, SafetyController) as Permission[]) ??
    []
  );
}

const allows = (role: UserRole, route: Route) =>
  required(route).length > 0 && required(route).every((p) => roleHasPermission(role, p));

describe('waste type permissions', () => {
  it('reads with SAFETY_VIEW and changes with SAFETY_MANAGE', () => {
    expect(required('wasteTypes')).toEqual([Permission.SAFETY_VIEW]);
    for (const route of ['createWasteType', 'updateWasteType', 'deleteWasteType'] as Route[]) {
      expect(required(route)).toEqual([Permission.SAFETY_MANAGE]);
    }
  });

  it('leaves the whole list to the Safety Officer, whose sheet it is', () => {
    for (const route of [
      'wasteTypes',
      'createWasteType',
      'updateWasteType',
      'deleteWasteType',
    ] as Route[]) {
      expect(allows('SUPERVISOR', route)).toBe(true);
    }
  });

  it('keeps the watchman out', () => {
    for (const route of ['wasteTypes', 'createWasteType'] as Route[]) {
      expect(allows('WATCHMAN', route)).toBe(false);
    }
  });
});

describe('waste defaults', () => {
  it('offers the eight streams the client named, in their order', () => {
    expect([...DEFAULT_WASTE_TYPES]).toEqual([
      'Civil / Block Waste',
      'Gypsum Waste',
      'Wooden Waste',
      'Paper Waste',
      'Scrap / Metal Waste',
      'Hazardous Waste',
      'Electrical / E-Waste',
      'Food Waste',
    ]);
  });

  it('has no duplicates, which the unique index would refuse anyway', () => {
    expect(new Set(DEFAULT_WASTE_TYPES).size).toBe(DEFAULT_WASTE_TYPES.length);
  });

  // The breakdown replaces this metric's typed figure but not the metric: every
  // total, chart and export still reads it, so it has to stay in the catalogue.
  it('keeps the waste metric on the sheet', () => {
    expect(METRIC_CATALOG.some((m) => m.metric === WASTE_METRIC)).toBe(true);
  });
});
