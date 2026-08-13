import { ClassConstructor, plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateWorkerDto, UpdateWorkerDto } from './dto/worker.dto';

/**
 * A person registered without a site belongs to no site, and belonging to no
 * site is invisibility: they are missing from the Safety Officer's list, whose
 * search box only filters rows already loaded, and missing from the offline
 * cache that same list fills — so they scan fine while the tablet has signal
 * and cannot be scanned at all once it drops.
 *
 * Two people were created that way before this was enforced. The forms ask for
 * a site now, but the rule belongs here, where no client can skip it.
 */

const person = {
  fullName: 'Ramesh Kumar',
  category: 'WORKER',
};

const errorsOn = async (dto: object, cls: ClassConstructor<object>) => {
  const errors = await validate(plainToInstance(cls, dto));
  return errors.map((e) => e.property);
};

describe('CreateWorkerDto', () => {
  it('refuses a person with no site', async () => {
    await expect(errorsOn(person, CreateWorkerDto)).resolves.toContain('siteId');
  });

  it('refuses a blank, whitespace or junk site', async () => {
    for (const siteId of ['', '   ', 'not-a-site']) {
      // Junk would otherwise reach the insert and fail on the foreign key as a
      // 500; this turns it into a plain "pick the site" at the form.
      await expect(errorsOn({ ...person, siteId }, CreateWorkerDto)).resolves.toContain('siteId');
    }
  });

  it('accepts one with a site', async () => {
    await expect(
      errorsOn({ ...person, siteId: 'a6c2e1f7-770c-4298-a5e3-0cf3194aa8f7' }, CreateWorkerDto),
    ).resolves.not.toContain('siteId');
  });

  it('leaves editing an existing person alone', async () => {
    // Every field is optional on update, and moving somebody between sites has
    // its own endpoint — requiring it here would block unrelated edits.
    await expect(errorsOn({ fullName: 'Ramesh Kumar' }, UpdateWorkerDto)).resolves.not.toContain(
      'siteId',
    );
  });
});
