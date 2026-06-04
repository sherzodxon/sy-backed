import { prisma } from "../src/lib/prisma";
import bcrypt from "bcryptjs";


async function main() {
  const email = process.env.ADMIN_EMAIL || "admin@sherzodxon.uz";
  const password = process.env.ADMIN_PASSWORD || "changeme123";
  const name = process.env.ADMIN_NAME || "Sherzodxon";

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    // Promote to admin if not already
    if (existing.role !== "ADMIN") {
      await prisma.user.update({ where: { email }, data: { role: "ADMIN" } });
      console.log(`✅ Promoted ${email} to ADMIN`);
    } else {
      console.log(`ℹ️  Admin user ${email} already exists`);
    }
    return;
  }

  const hashed = await bcrypt.hash(password, 10);
  await prisma.user.create({
    data: { name, email, password: hashed, role: "ADMIN" },
  });

  console.log(`✅ Admin user created:`);
  console.log(`   Email:    ${email}`);
  console.log(`   Password: ${password}`);
  console.log(`   ⚠️  Change the password after first login!`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
