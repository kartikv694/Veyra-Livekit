/*
  Warnings:

  - You are about to drop the column `startedAt` on the `Meeting` table. All the data in the column will be lost.
  - You are about to drop the `Notification` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "Notification" DROP CONSTRAINT "Notification_userId_fkey";

-- AlterTable
ALTER TABLE "Meeting" DROP COLUMN "startedAt";

-- AlterTable
ALTER TABLE "Users" ADD COLUMN     "resetCodeExpiresAt" TIMESTAMP(3),
ADD COLUMN     "resetCodeHash" TEXT;

-- DropTable
DROP TABLE "Notification";
