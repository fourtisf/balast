-- AlterTable
ALTER TABLE "tokens" ADD COLUMN     "supply_read_at" TIMESTAMP(3),
ADD COLUMN     "total_supply" DECIMAL(78,0);
