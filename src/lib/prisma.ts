/**
 * Prisma client singleton.
 *
 * Next.js reloads modules on every request in dev mode. Without caching the
 * client on `globalThis`, each hot-reload would open a fresh connection pool
 * to Postgres and eventually exhaust the database's connection limit. In
 * production a single instance per server process is created once and reused.
 *
 * Usage:
 *   import { prisma } from "@/lib/prisma";
 *   const user = await prisma.users.findUnique({ where: { id: 1 } });
 */
import { PrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

function createPrismaClient(): PrismaClient {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
  return new PrismaClient({ adapter });
}

export const prisma: PrismaClient = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
