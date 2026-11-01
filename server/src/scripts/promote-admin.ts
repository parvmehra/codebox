import { Role } from '@prisma/client';
import { prisma } from '../database/prisma.js';

// Operator-only: promotes an existing account, e.g.
//   docker compose exec api node server/dist/scripts/promote-admin.js you@example.com
// Done from the command line (not by a signup rule) so nobody can claim admin by registering first.
const email = process.argv[2]?.trim().toLowerCase();
if (!email) {
  console.error('Usage: promote-admin <email>');
  process.exit(2);
}

const result = await prisma.user.updateMany({ where: { email }, data: { role: Role.ADMIN } });
await prisma.$disconnect();
if (result.count !== 1) {
  console.error('No account with that email exists. Register it first, then run this again.');
  process.exit(1);
}
console.log(`${email} is now an admin. Existing tokens pick up the role immediately.`);
