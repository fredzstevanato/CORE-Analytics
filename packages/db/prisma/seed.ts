import { prisma } from "../src/client";
import { hashPassword } from "@core/shared";

async function main() {
  const user = await prisma.user.upsert({
    where: { email: process.env.MOCK_USER_EMAIL ?? "analista@core.local" },
    update: {
      passwordHash: hashPassword(process.env.MOCK_USER_PASSWORD ?? "Admin@123")
    },
    create: {
      email: process.env.MOCK_USER_EMAIL ?? "analista@core.local",
      name: "Analista Padrão",
      role: "ADMIN",
      passwordHash: hashPassword(process.env.MOCK_USER_PASSWORD ?? "Admin@123")
    }
  });

  await prisma.case.upsert({
    where: { caseNumber: "CASE-0001" },
    update: {},
    create: {
      caseNumber: "CASE-0001",
      title: "Caso Demo UFDR",
      description: "Caso de desenvolvimento para ingestão e parsing inicial.",
      ownerId: user.id
    }
  });
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
