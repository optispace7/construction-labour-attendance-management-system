import { appVersionFrom, LEGACY_APP_VERSION } from './app-version';

describe('appVersionFrom', () => {
  it('passes a version through', () => {
    expect(appVersionFrom('1.1.0+62')).toBe('1.1.0+62');
  });

  it('calls an app that sends no header legacy', () => {
    expect(appVersionFrom(undefined)).toBe(LEGACY_APP_VERSION);
    expect(appVersionFrom('   ')).toBe(LEGACY_APP_VERSION);
  });

  it('takes the first of a repeated header and bounds its length', () => {
    expect(appVersionFrom(['1.1.0+62', '9.9.9'])).toBe('1.1.0+62');
    expect(appVersionFrom('x'.repeat(200))).toHaveLength(40);
  });
});
