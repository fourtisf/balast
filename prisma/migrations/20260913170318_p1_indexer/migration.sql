-- CreateTable
CREATE TABLE "tokens" (
    "address" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "decimals" INTEGER NOT NULL DEFAULT 18,
    "logo_url" TEXT,
    "logo_color" TEXT,
    "launchpad" TEXT,
    "first_seen" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tokens_pkey" PRIMARY KEY ("address")
);

-- CreateTable
CREATE TABLE "pools" (
    "id" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "chain_id" INTEGER NOT NULL,
    "token0" TEXT NOT NULL,
    "token1" TEXT NOT NULL,
    "fee_tier" INTEGER NOT NULL,
    "tick_spacing" INTEGER NOT NULL,
    "hooks" TEXT,
    "protocol" TEXT NOT NULL,
    "created_block" BIGINT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL,
    "stakeable" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "pools_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "swap_events" (
    "tx_hash" TEXT NOT NULL,
    "log_index" INTEGER NOT NULL,
    "pool_id" TEXT NOT NULL,
    "block_num" BIGINT NOT NULL,
    "block_time" TIMESTAMP(3) NOT NULL,
    "amount0" DECIMAL(78,0) NOT NULL,
    "amount1" DECIMAL(78,0) NOT NULL,
    "sqrt_price_x96" DECIMAL(78,0) NOT NULL,
    "liquidity" DECIMAL(78,0) NOT NULL,
    "tick" INTEGER NOT NULL,
    "fee_amount" DECIMAL(78,0) NOT NULL,
    "fee_token" INTEGER NOT NULL,
    "sender" TEXT NOT NULL,

    CONSTRAINT "swap_events_pkey" PRIMARY KEY ("tx_hash","log_index")
);

-- CreateTable
CREATE TABLE "liquidity_events" (
    "tx_hash" TEXT NOT NULL,
    "log_index" INTEGER NOT NULL,
    "pool_id" TEXT NOT NULL,
    "block_num" BIGINT NOT NULL,
    "block_time" TIMESTAMP(3) NOT NULL,
    "tick_lower" INTEGER NOT NULL,
    "tick_upper" INTEGER NOT NULL,
    "liquidity_delta" DECIMAL(78,0) NOT NULL,
    "amount0" DECIMAL(78,0) NOT NULL,
    "amount1" DECIMAL(78,0) NOT NULL,
    "owner" TEXT NOT NULL,

    CONSTRAINT "liquidity_events_pkey" PRIMARY KEY ("tx_hash","log_index")
);

-- CreateTable
CREATE TABLE "indexer_cursors" (
    "contract" TEXT NOT NULL,
    "last_indexed_block" BIGINT NOT NULL,
    "last_indexed_at" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "indexer_cursors_pkey" PRIMARY KEY ("contract")
);

-- CreateTable
CREATE TABLE "pool_fee_hourly" (
    "pool_id" TEXT NOT NULL,
    "hour" TIMESTAMP(3) NOT NULL,
    "fees_token0" DECIMAL(78,0) NOT NULL,
    "fees_token1" DECIMAL(78,0) NOT NULL,
    "fees_usd" DECIMAL(38,18) NOT NULL,
    "volume_usd" DECIMAL(38,18) NOT NULL,
    "swaps" INTEGER NOT NULL,

    CONSTRAINT "pool_fee_hourly_pkey" PRIMARY KEY ("pool_id","hour")
);

-- CreateTable
CREATE TABLE "pool_flow_hourly" (
    "pool_id" TEXT NOT NULL,
    "hour" TIMESTAMP(3) NOT NULL,
    "delta0" DECIMAL(78,0) NOT NULL,
    "delta1" DECIMAL(78,0) NOT NULL,

    CONSTRAINT "pool_flow_hourly_pkey" PRIMARY KEY ("pool_id","hour")
);

-- CreateTable
CREATE TABLE "weth_usd_hourly" (
    "hour" TIMESTAMP(3) NOT NULL,
    "weth_usd" DECIMAL(38,18) NOT NULL,

    CONSTRAINT "weth_usd_hourly_pkey" PRIMARY KEY ("hour")
);

-- CreateTable
CREATE TABLE "pool_state" (
    "pool_id" TEXT NOT NULL,
    "tvl_usd" DECIMAL(38,18) NOT NULL,
    "price_usd" DECIMAL(38,18) NOT NULL,
    "mc_usd" DECIMAL(38,18) NOT NULL,
    "sqrt_price_x96" DECIMAL(78,0) NOT NULL,
    "tick" INTEGER NOT NULL,
    "liquidity" DECIMAL(78,0) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pool_state_pkey" PRIMARY KEY ("pool_id")
);

-- CreateTable
CREATE TABLE "vaults" (
    "pool_id" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "total_staked" DECIMAL(78,0) NOT NULL,
    "total_staked_usd" DECIMAL(38,18) NOT NULL,
    "reward_rate" DECIMAL(78,0) NOT NULL,
    "period_finish" TIMESTAMP(3) NOT NULL,
    "stakers" INTEGER NOT NULL,
    "protocol_fee_bps" INTEGER NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vaults_pkey" PRIMARY KEY ("pool_id")
);

-- CreateTable
CREATE TABLE "stakes" (
    "wallet" TEXT NOT NULL,
    "vault_id" TEXT NOT NULL,
    "shares" DECIMAL(78,0) NOT NULL,
    "claimed_weth" DECIMAL(78,0) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stakes_pkey" PRIMARY KEY ("wallet","vault_id")
);

-- CreateTable
CREATE TABLE "positions" (
    "token_id" TEXT NOT NULL,
    "wallet" TEXT NOT NULL,
    "pool_id" TEXT NOT NULL,
    "tick_lower" INTEGER NOT NULL,
    "tick_upper" INTEGER NOT NULL,
    "liquidity" DECIMAL(78,0) NOT NULL,
    "shape" TEXT,
    "status" TEXT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "positions_pkey" PRIMARY KEY ("token_id")
);

-- CreateTable
CREATE TABLE "router_configs" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "fee_source" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "cadence_s" INTEGER,
    "milestones_json" JSONB,
    "paused" BOOLEAN NOT NULL DEFAULT false,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "router_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "router_routes" (
    "id" TEXT NOT NULL,
    "config_id" TEXT NOT NULL,
    "tx_hash" TEXT NOT NULL,
    "weth_in" DECIMAL(78,0) NOT NULL,
    "liquidity_added" DECIMAL(78,0) NOT NULL,
    "twap_price" DECIMAL(38,18) NOT NULL,
    "routed_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "router_routes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tokens_symbol_idx" ON "tokens"("symbol");

-- CreateIndex
CREATE INDEX "pools_protocol_idx" ON "pools"("protocol");

-- CreateIndex
CREATE UNIQUE INDEX "pools_address_chain_id_key" ON "pools"("address", "chain_id");

-- CreateIndex
CREATE INDEX "swap_events_pool_id_block_time_idx" ON "swap_events"("pool_id", "block_time");

-- CreateIndex
CREATE INDEX "swap_events_block_num_idx" ON "swap_events"("block_num");

-- CreateIndex
CREATE INDEX "swap_events_pool_id_block_num_log_index_idx" ON "swap_events"("pool_id", "block_num", "log_index");

-- CreateIndex
CREATE INDEX "liquidity_events_pool_id_block_time_idx" ON "liquidity_events"("pool_id", "block_time");

-- CreateIndex
CREATE INDEX "liquidity_events_block_num_idx" ON "liquidity_events"("block_num");

-- CreateIndex
CREATE INDEX "pool_fee_hourly_hour_idx" ON "pool_fee_hourly"("hour");

-- CreateIndex
CREATE UNIQUE INDEX "vaults_address_key" ON "vaults"("address");

-- CreateIndex
CREATE INDEX "stakes_wallet_idx" ON "stakes"("wallet");

-- CreateIndex
CREATE INDEX "positions_wallet_idx" ON "positions"("wallet");

-- CreateIndex
CREATE INDEX "router_configs_token_idx" ON "router_configs"("token");

-- CreateIndex
CREATE UNIQUE INDEX "router_routes_tx_hash_key" ON "router_routes"("tx_hash");

-- CreateIndex
CREATE INDEX "router_routes_config_id_routed_at_idx" ON "router_routes"("config_id", "routed_at");

-- AddForeignKey
ALTER TABLE "pools" ADD CONSTRAINT "pools_token0_fkey" FOREIGN KEY ("token0") REFERENCES "tokens"("address") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pools" ADD CONSTRAINT "pools_token1_fkey" FOREIGN KEY ("token1") REFERENCES "tokens"("address") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "swap_events" ADD CONSTRAINT "swap_events_pool_id_fkey" FOREIGN KEY ("pool_id") REFERENCES "pools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "liquidity_events" ADD CONSTRAINT "liquidity_events_pool_id_fkey" FOREIGN KEY ("pool_id") REFERENCES "pools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pool_fee_hourly" ADD CONSTRAINT "pool_fee_hourly_pool_id_fkey" FOREIGN KEY ("pool_id") REFERENCES "pools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pool_flow_hourly" ADD CONSTRAINT "pool_flow_hourly_pool_id_fkey" FOREIGN KEY ("pool_id") REFERENCES "pools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pool_state" ADD CONSTRAINT "pool_state_pool_id_fkey" FOREIGN KEY ("pool_id") REFERENCES "pools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vaults" ADD CONSTRAINT "vaults_pool_id_fkey" FOREIGN KEY ("pool_id") REFERENCES "pools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stakes" ADD CONSTRAINT "stakes_vault_id_fkey" FOREIGN KEY ("vault_id") REFERENCES "vaults"("pool_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "positions" ADD CONSTRAINT "positions_pool_id_fkey" FOREIGN KEY ("pool_id") REFERENCES "pools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "router_routes" ADD CONSTRAINT "router_routes_config_id_fkey" FOREIGN KEY ("config_id") REFERENCES "router_configs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
