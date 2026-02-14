import type { ExchangeAdapter } from "../interfaces/exchange.js";
import { HyperliquidAdapter } from "./hyperliquid/adapter.js";

const REG = {
  hyperliquid: HyperliquidAdapter,
  hl: HyperliquidAdapter,
} as const;

export function createExchangeAdapter(
  exchangeType: string,
  config: { private_key: string; testnet: boolean },
): ExchangeAdapter {
  const C = (REG as Record<string, new (k: string, t: boolean) => ExchangeAdapter>)[exchangeType];
  if (!C) {
    throw new Error(`Unknown exchange: ${exchangeType}`);
  }
  if (!config.private_key) {
    throw new Error("private_key is required");
  }
  return new C(config.private_key, config.testnet);
}
