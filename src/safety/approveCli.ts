import { eq } from 'drizzle-orm';
import { getDb, closeDb } from '../db/client.js';
import { approvals } from '../db/schema.js';

async function main() {
  const [, , idArg, decisionArg] = process.argv;
  if (!idArg) {
    console.error('usage: npm run approve <approval-id> [approve|reject]');
    process.exit(2);
  }
  const decision = (decisionArg ?? 'approve').toLowerCase();
  if (decision !== 'approve' && decision !== 'reject') {
    console.error("decision must be 'approve' or 'reject'");
    process.exit(2);
  }

  const db = getDb();
  const [current] = await db.select().from(approvals).where(eq(approvals.id, idArg));
  if (!current) {
    console.error(`no approval found with id=${idArg}`);
    process.exit(1);
  }
  if (current.status !== 'pending') {
    console.error(`approval ${idArg} is ${current.status}, not pending`);
    process.exit(1);
  }

  await db
    .update(approvals)
    .set({
      status: decision === 'approve' ? 'approved' : 'rejected',
      decidedAt: new Date(),
    })
    .where(eq(approvals.id, idArg));

  console.log(`approval ${idArg} -> ${decision}d`);
  await closeDb();
}

main().catch(async (err) => {
  console.error(err);
  await closeDb();
  process.exit(1);
});
