/**
 * DEMO ONLY — adds a small, clearly-tagged set of people for a client walkthrough:
 *   - registered today:      4 workers, 3 staff, 2 visitors
 *   - registered yesterday:  2 workers, 1 staff, 1 visitor (with yesterday's attendance)
 *
 * Every row it creates carries notes = DEMO_TAG and uses the reserved 9xxx code
 * band (W-9001…, S-9001…, V-9001…), so nothing collides with real records and
 * cleanup is exact. Attendance sessions are created to match: today's people are
 * mostly still on site (OPEN), yesterday's people have a closed day behind them
 * (one AUTO_CLOSED, to demo the missed-logout card).
 *
 * Mirrors WorkersService.create(): worker + QR credential + site assignment.
 *
 *   DATABASE_URL=... npx ts-node prisma/seed-demo-client.ts          # create
 *   DATABASE_URL=... npx ts-node prisma/seed-demo-client.ts --undo   # remove everything it made
 */
import { PrismaClient, PersonCategory } from '@prisma/client';

const prisma = new PrismaClient();

const DEMO_TAG = 'DEMO_CLIENT_2026-07-11';

/** IST midnight (as a UTC Date) for a day offset from today — matches workDate semantics. */
function dayFor(daysAgo: number): Date {
  const ist = new Date(Date.now() + 5.5 * 3600_000);
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() - daysAgo));
}
/** A Date at IST wall-clock hh:mm on a day offset from today. */
function istAt(daysAgo: number, hour: number, minute: number): Date {
  return new Date(dayFor(daysAgo).getTime() + (hour - 5.5) * 3600_000 + minute * 60_000);
}

type Person = {
  code: string;
  category: PersonCategory;
  fullName: string;
  addedDaysAgo: 0 | 1;
  site: string; // site code
  vendor?: string; // vendor code
  designation?: string; // designation name
  fatherName?: string;
  gender?: string;
  dob?: string;
  mobile?: string;
  bloodGroup?: string;
  emergencyName?: string;
  emergencyNumber?: string;
  nomineeName?: string;
  nomineeRelation?: string;
  natureOfContractor?: string;
  escortName?: string;
  visitorCompany?: string;
  purpose?: string;
};

const PEOPLE: Person[] = [
  // ---- Registered TODAY: 4 workers ----
  { code: 'W-9001', category: 'WORKER', fullName: 'Mahesh Pawar', addedDaysAgo: 0, site: 'WFT', vendor: 'SRI', designation: 'Mason', fatherName: 'Ganpat Pawar', gender: 'MALE', dob: '1991-03-14', mobile: '9845102371', bloodGroup: 'B+', emergencyName: 'Sunita Pawar', emergencyNumber: '9845102372', nomineeName: 'Sunita Pawar', nomineeRelation: 'Wife', natureOfContractor: 'Civil works' },
  { code: 'W-9002', category: 'WORKER', fullName: 'Irfan Qureshi', addedDaysAgo: 0, site: 'WFT', vendor: 'BRC', designation: 'Electrician', fatherName: 'Yusuf Qureshi', gender: 'MALE', dob: '1988-11-02', mobile: '9845102373', bloodGroup: 'O+', emergencyName: 'Rukhsana Qureshi', emergencyNumber: '9845102374', nomineeName: 'Rukhsana Qureshi', nomineeRelation: 'Wife', natureOfContractor: 'Electrical' },
  { code: 'W-9003', category: 'WORKER', fullName: 'Devi Priya', addedDaysAgo: 0, site: 'IN1', vendor: 'SKM', designation: 'Painter', fatherName: 'Subramani', gender: 'FEMALE', dob: '1995-07-23', mobile: '9845102375', bloodGroup: 'A+', emergencyName: 'Subramani', emergencyNumber: '9845102376', nomineeName: 'Subramani', nomineeRelation: 'Father', natureOfContractor: 'Finishing' },
  { code: 'W-9004', category: 'WORKER', fullName: 'Rakesh Bhoi', addedDaysAgo: 0, site: 'BRG-WTC28', vendor: 'ANNAI', designation: 'Steel Fixer', fatherName: 'Naresh Bhoi', gender: 'MALE', dob: '1993-01-09', mobile: '9845102377', bloodGroup: 'AB+', emergencyName: 'Kamla Bhoi', emergencyNumber: '9845102378', nomineeName: 'Kamla Bhoi', nomineeRelation: 'Mother', natureOfContractor: 'Structural' },

  // ---- Registered TODAY: 3 staff ----
  { code: 'S-9001', category: 'STAFF', fullName: 'Nandini Rao', addedDaysAgo: 0, site: 'WFT', vendor: 'SRI', designation: 'Site Engineer', fatherName: 'Prakash Rao', gender: 'FEMALE', dob: '1994-05-30', mobile: '9845102379', bloodGroup: 'B+', emergencyName: 'Prakash Rao', emergencyNumber: '9845102380', nomineeName: 'Prakash Rao', nomineeRelation: 'Father' },
  { code: 'S-9002', category: 'STAFF', fullName: 'Harish Gowda', addedDaysAgo: 0, site: 'IN1', vendor: 'VELAN', designation: 'Storekeeper', fatherName: 'Shivanna Gowda', gender: 'MALE', dob: '1990-09-17', mobile: '9845102381', bloodGroup: 'O-', emergencyName: 'Latha Gowda', emergencyNumber: '9845102382', nomineeName: 'Latha Gowda', nomineeRelation: 'Wife' },
  { code: 'S-9003', category: 'STAFF', fullName: 'Faisal Ahmed', addedDaysAgo: 0, site: 'BRG-WTC28', vendor: 'BRC', designation: 'Security Guard', fatherName: 'Nizam Ahmed', gender: 'MALE', dob: '1987-12-05', mobile: '9845102383', bloodGroup: 'A-', emergencyName: 'Shabana Ahmed', emergencyNumber: '9845102384', nomineeName: 'Shabana Ahmed', nomineeRelation: 'Wife' },

  // ---- Registered TODAY: 2 visitors (day passes) ----
  { code: 'V-9001', category: 'VISITOR', fullName: 'Sanjay Bhatt', addedDaysAgo: 0, site: 'WFT', mobile: '9845102385', visitorCompany: 'Skyline Architects', escortName: 'Nandini Rao', purpose: 'Structural drawings review' },
  { code: 'V-9002', category: 'VISITOR', fullName: 'Preethi Nair', addedDaysAgo: 0, site: 'BRG-WTC28', mobile: '9845102386', visitorCompany: 'Aegis Safety Audit', escortName: 'Faisal Ahmed', purpose: 'Monthly safety audit' },

  // ---- Registered YESTERDAY: 2 workers, 1 staff, 1 visitor ----
  { code: 'W-9005', category: 'WORKER', fullName: 'Sathish Kumar V', addedDaysAgo: 1, site: 'WFT', vendor: 'SRI', designation: 'Carpenter', fatherName: 'Velu', gender: 'MALE', dob: '1992-02-19', mobile: '9845102387', bloodGroup: 'O+', emergencyName: 'Revathi', emergencyNumber: '9845102388', nomineeName: 'Revathi', nomineeRelation: 'Wife', natureOfContractor: 'Carpentry' },
  { code: 'W-9006', category: 'WORKER', fullName: 'Jagdish Yadav', addedDaysAgo: 1, site: 'IN1', vendor: 'SKM', designation: 'Helper', fatherName: 'Ram Yadav', gender: 'MALE', dob: '1998-06-11', mobile: '9845102389', bloodGroup: 'B-', emergencyName: 'Ram Yadav', emergencyNumber: '9845102390', nomineeName: 'Ram Yadav', nomineeRelation: 'Father', natureOfContractor: 'General labour' },
  { code: 'S-9004', category: 'STAFF', fullName: 'Ananya Iyer', addedDaysAgo: 1, site: 'WFT', vendor: 'SRI', designation: 'Site Engineer', fatherName: 'Ramesh Iyer', gender: 'FEMALE', dob: '1996-04-27', mobile: '9845102391', bloodGroup: 'A+', emergencyName: 'Ramesh Iyer', emergencyNumber: '9845102392', nomineeName: 'Ramesh Iyer', nomineeRelation: 'Father' },
  { code: 'V-9003', category: 'VISITOR', fullName: 'Girish Kulkarni', addedDaysAgo: 1, site: 'IN1', mobile: '9845102393', visitorCompany: 'Sterling Cement', escortName: 'Ananya Iyer', purpose: 'Material sample delivery' },
];

/** Attendance to create, keyed by person code. */
type Sess = {
  code: string;
  daysAgo: 0 | 1;
  inH: number;
  inM: number;
  outH?: number;
  outM?: number;
  state: 'OPEN' | 'CLOSED' | 'AUTO_CLOSED';
};
const SESSIONS: Sess[] = [
  // Yesterday — the four people who joined yesterday put in a full day.
  { code: 'W-9005', daysAgo: 1, inH: 7, inM: 45, outH: 18, outM: 10, state: 'CLOSED' },
  { code: 'W-9006', daysAgo: 1, inH: 7, inM: 50, state: 'AUTO_CLOSED' }, // never logged out
  { code: 'S-9004', daysAgo: 1, inH: 9, inM: 5, outH: 18, outM: 20, state: 'CLOSED' },
  { code: 'V-9003', daysAgo: 1, inH: 11, inM: 0, outH: 13, outM: 30, state: 'CLOSED' },

  // Today — it is mid-morning IST, so nearly everyone is still on site.
  { code: 'W-9001', daysAgo: 0, inH: 7, inM: 42, state: 'OPEN' },
  { code: 'W-9002', daysAgo: 0, inH: 7, inM: 55, state: 'OPEN' },
  { code: 'W-9003', daysAgo: 0, inH: 8, inM: 5, state: 'OPEN' },
  { code: 'W-9004', daysAgo: 0, inH: 8, inM: 20, state: 'OPEN' },
  { code: 'S-9001', daysAgo: 0, inH: 9, inM: 5, state: 'OPEN' },
  { code: 'S-9002', daysAgo: 0, inH: 9, inM: 12, state: 'OPEN' },
  { code: 'S-9003', daysAgo: 0, inH: 9, inM: 20, state: 'OPEN' },
  { code: 'V-9001', daysAgo: 0, inH: 9, inM: 30, state: 'OPEN' },
  { code: 'V-9002', daysAgo: 0, inH: 8, inM: 50, outH: 9, outM: 25, state: 'CLOSED' },
  // Yesterday's joiners are back today.
  { code: 'W-9005', daysAgo: 0, inH: 7, inM: 48, state: 'OPEN' },
  { code: 'W-9006', daysAgo: 0, inH: 8, inM: 12, state: 'OPEN' },
  { code: 'S-9004', daysAgo: 0, inH: 9, inM: 2, state: 'OPEN' },
];

const AUTO_CREDIT_MINUTES = 8 * 60;
const DEFAULT_WORKDAY_MINUTES = 480;

async function undo() {
  const codes = PEOPLE.map((p) => p.code);
  const workers = await prisma.worker.findMany({
    where: { workerCode: { in: codes }, notes: DEMO_TAG },
    select: { id: true, workerCode: true },
  });
  if (workers.length === 0) {
    console.log('Nothing to undo — no demo people found.');
    return;
  }
  const ids = workers.map((w) => w.id);
  // Sessions have no cascade from Worker; delete them before the people.
  const sessions = await prisma.attendanceSession.deleteMany({ where: { workerId: { in: ids } } });
  const taps = await prisma.attendanceTap.deleteMany({ where: { workerId: { in: ids } } });
  const people = await prisma.worker.deleteMany({ where: { id: { in: ids } } });
  console.log(
    `Removed ${people.count} demo person(s) [${workers.map((w) => w.workerCode).join(', ')}], ` +
      `${sessions.count} session(s), ${taps.count} tap(s). Assignments + QR credentials cascaded.`,
  );
}

async function seed() {
  const org = await prisma.organization.findFirst({ where: { isActive: true } });
  if (!org) throw new Error('No active organization.');

  const sites = await prisma.site.findMany({ where: { organizationId: org.id } });
  const vendors = await prisma.vendor.findMany({ where: { organizationId: org.id } });
  const designations = await prisma.designation.findMany({ where: { organizationId: org.id } });
  const siteId = (code: string) => {
    const s = sites.find((x) => x.code === code);
    if (!s) throw new Error(`Site ${code} not found`);
    return s.id;
  };
  const vendorId = (code?: string) => (code ? vendors.find((v) => v.code === code)?.id : undefined);
  const designationId = (name?: string) =>
    name ? designations.find((d) => d.name === name)?.id : undefined;

  const existing = await prisma.worker.findMany({
    where: { organizationId: org.id, workerCode: { in: PEOPLE.map((p) => p.code) } },
    select: { workerCode: true },
  });
  if (existing.length > 0) {
    throw new Error(
      `These demo codes already exist: ${existing.map((e) => e.workerCode).join(', ')}. ` +
        `Run with --undo first.`,
    );
  }

  const byCode = new Map<string, string>(); // workerCode -> worker id
  const siteOf = new Map<string, string>(); // workerCode -> site id

  for (const p of PEOPLE) {
    const joinDate = dayFor(p.addedDaysAgo);
    const isVisitor = p.category === 'VISITOR';
    // A visitor pass is valid for the visit day only; worker/staff cards for a year.
    const validityTill = isVisitor ? joinDate : dayFor(-365);
    // Yesterday's visitor pass is already spent — the nightly job would EXIT it anyway.
    const expiredPass = isVisitor && p.addedDaysAgo === 1;

    const w = await prisma.worker.create({
      data: {
        organizationId: org.id,
        workerCode: p.code,
        qrIdentifier: p.code,
        category: p.category,
        fullName: p.fullName,
        fatherName: p.fatherName,
        gender: p.gender,
        dateOfBirth: p.dob ? new Date(`${p.dob}T00:00:00.000Z`) : undefined,
        mobileNumber: p.mobile,
        bloodGroup: p.bloodGroup,
        emergencyContactName: p.emergencyName,
        emergencyContactNumber: p.emergencyNumber,
        nomineeName: p.nomineeName,
        nomineeRelation: p.nomineeRelation,
        vendorId: vendorId(p.vendor),
        designationId: designationId(p.designation),
        natureOfContractor: p.natureOfContractor,
        escortName: p.escortName,
        visitorCompany: p.visitorCompany,
        screeningDoneOn: isVisitor ? undefined : joinDate,
        screeningDoneBy: isVisitor ? undefined : 'Safety Cell',
        inductionDoneOn: isVisitor ? undefined : joinDate,
        inductedBy: isVisitor ? undefined : 'Safety Cell',
        validityTill,
        joinDate,
        status: expiredPass ? 'EXITED' : 'ACTIVE',
        exitDate: expiredPass ? joinDate : undefined,
        notes: DEMO_TAG,
        createdAt: istAt(p.addedDaysAgo, 9, 30),
      },
      select: { id: true },
    });

    await prisma.workerCredential.create({
      data: { workerId: w.id, kind: 'QR', value: p.code },
    });
    await prisma.workerSiteAssignment.create({
      data: {
        workerId: w.id,
        siteId: siteId(p.site),
        vendorId: vendorId(p.vendor),
        startDate: joinDate,
      },
    });

    byCode.set(p.code, w.id);
    siteOf.set(p.code, siteId(p.site));
    console.log(`  + ${p.code}  ${p.fullName.padEnd(20)} ${p.category.padEnd(8)} ${p.site}`);
  }

  console.log(`\nCreated ${PEOPLE.length} people. Now attendance…`);

  for (const s of SESSIONS) {
    const workerId = byCode.get(s.code)!;
    const loginAt = istAt(s.daysAgo, s.inH, s.inM);
    const isVisitor = s.code.startsWith('V-');

    let logoutAt: Date | undefined;
    let workedMinutes: number | undefined;
    let closedReason: string | undefined;

    if (s.state === 'AUTO_CLOSED') {
      logoutAt = new Date(loginAt.getTime() + AUTO_CREDIT_MINUTES * 60_000);
      workedMinutes = AUTO_CREDIT_MINUTES;
      closedReason = 'no logout — auto-closed with 8h credited';
    } else if (s.state === 'CLOSED') {
      logoutAt = istAt(s.daysAgo, s.outH!, s.outM!);
      workedMinutes = Math.round((logoutAt.getTime() - loginAt.getTime()) / 60_000);
    }

    await prisma.attendanceSession.create({
      data: {
        organizationId: org.id,
        workerId,
        siteId: siteOf.get(s.code)!,
        workDate: dayFor(s.daysAgo),
        loginAt,
        logoutAt,
        state: s.state,
        workedMinutes,
        overtimeMinutes:
          workedMinutes === undefined || isVisitor
            ? undefined
            : Math.max(0, workedMinutes - DEFAULT_WORKDAY_MINUTES),
        closedReason,
      },
    });
    const when = s.daysAgo === 0 ? 'today    ' : 'yesterday';
    console.log(`  + ${s.code}  ${when}  ${s.state}`);
  }

  console.log(`\nCreated ${SESSIONS.length} attendance session(s).`);
  console.log(`All rows tagged notes="${DEMO_TAG}" — undo with: npx ts-node prisma/seed-demo-client.ts --undo`);
}

async function main() {
  if (process.argv.includes('--undo')) await undo();
  else await seed();
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
