import { ClassConstructor, plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateWorkerDto, UpdateWorkerDto } from './dto/worker.dto';

/**
 * Staff ID cards print a "Mail Id" line, so a staff record carries a work
 * e-mail of its own — the login user's e-mail belongs to a different record and
 * not every staff member has a login at all.
 *
 * It is optional, and optional here has to mean removable: the admin form sends
 * a blank when the box is cleared, and a validator that refused that would let
 * a mistyped address be corrected but never deleted, leaving it printing on
 * every reissued card.
 */
const person = {
  fullName: 'Saneesh T B',
  category: 'STAFF',
  siteId: 'a6c2e1f7-770c-4298-a5e3-0cf3194aa8f7',
};

const errorsOn = async (dto: object, cls: ClassConstructor<object>) => {
  const errors = await validate(plainToInstance(cls, dto));
  return errors.map((e) => e.property);
};

describe('work e-mail on a person', () => {
  it('accepts a real address', async () => {
    await expect(
      errorsOn({ ...person, email: 'saneesh@optispace.in' }, CreateWorkerDto),
    ).resolves.not.toContain('email');
  });

  it('accepts the field being left out entirely', async () => {
    await expect(errorsOn(person, CreateWorkerDto)).resolves.not.toContain('email');
  });

  it('accepts a blank, so clearing the box removes the address', async () => {
    await expect(errorsOn({ ...person, email: '' }, UpdateWorkerDto)).resolves.not.toContain(
      'email',
    );
  });

  it('refuses something that is not an address', async () => {
    for (const email of ['saneesh', 'saneesh@', '@optispace.in', 'a b@c.in']) {
      await expect(errorsOn({ ...person, email }, CreateWorkerDto)).resolves.toContain('email');
    }
  });
});
