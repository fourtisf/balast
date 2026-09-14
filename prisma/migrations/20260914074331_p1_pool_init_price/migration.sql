-- AlterTable
ALTER TABLE "pools" ADD COLUMN     "init_sqrt_price_x96" DECIMAL(78,0),
ADD COLUMN     "init_tick" INTEGER;
