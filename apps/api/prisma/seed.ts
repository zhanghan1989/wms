import { hash } from 'bcryptjs';
import { PrismaClient, Role } from '@prisma/client';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const adminPassword = await hash(process.env.SEED_ADMIN_PASSWORD ?? 'Admin@123', 10);
  const employeePassword = await hash(process.env.SEED_EMPLOYEE_PASSWORD ?? 'Employee@123', 10);

  await prisma.user.upsert({
    where: { username: 'admin' },
    update: {
      role: Role.admin,
      status: 1,
      passwordHash: adminPassword,
    },
    create: {
      username: 'admin',
      role: Role.admin,
      status: 1,
      passwordHash: adminPassword,
    },
  });

  await prisma.user.upsert({
    where: { username: 'employee' },
    update: {
      role: Role.employee,
      status: 1,
      passwordHash: employeePassword,
    },
    create: {
      username: 'employee',
      role: Role.employee,
      status: 1,
      passwordHash: employeePassword,
    },
  });
}

main()
  .catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
