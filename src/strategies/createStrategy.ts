import type { TradingStrategy } from "../interfaces/strategy.js";
import { BasicGridStrategy } from "./grid/basicGrid.js";

const REGISTRY: Record<string, new (c: Record<string, unknown>) => TradingStrategy> = {
  basic_grid: BasicGridStrategy,
  grid: BasicGridStrategy,
};

export function createStrategy(type: string, config: Record<string, unknown>): TradingStrategy {
  const C = REGISTRY[type];
  if (!C) {
    throw new Error(`Unknown strategy: ${type}. Available: ${Object.keys(REGISTRY).join(", ")}`);
  }
  return new C(config);
}
