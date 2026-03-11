import type {
  MarketData,
  Position,
  TradingSignal,
  TradingStrategy,
} from "../../interfaces/strategy.js";
import { SignalType } from "../../interfaces/strategy.js";

type GridState = "initializing" | "active" | "rebalancing" | "stopped";

type Level = {
  price: number;
  size: number;
  levelIndex: number;
  isBuyLevel: boolean;
  isFilled: boolean;
};

type GridParams = {
  symbol: string;
  levels: number;
  rangePct: number;
  totalAllocation: number;
  minPrice?: number;
  maxPrice?: number;
  rebalanceThresholdPct: number;
};

export class BasicGridStrategy implements TradingStrategy {
  name = "basic_grid";
  isActive = true;
  private state: GridState = "initializing";
  private centerPrice: number | null = null;
  private levels: Level[] = [];
  private lastRebalance = 0;
  private totalTrades = 0;
  private totalProfit = 0;
  private grid: GridParams;

  constructor(config: Record<string, unknown>) {
    this.grid = {
      symbol: (config.symbol as string) ?? "BTC",
      levels: (config.levels as number) ?? 10,
      rangePct: (config.range_pct as number) ?? 10,
      totalAllocation: (config.total_allocation as number) ?? 1000,
      minPrice: config.min_price as number | undefined,
      maxPrice: config.max_price as number | undefined,
      rebalanceThresholdPct: (config.rebalance_threshold_pct as number) ?? 15,
    };
  }

  start(): void {
    this.isActive = true;
  }

  stop(): void {
    this.isActive = false;
  }

  updateConfig(newConfig: Record<string, unknown>): void {
    Object.assign(this.grid, newConfig);
  }

  generateSignals(
    marketData: MarketData,
    _positions: Position[],
    balance: number,
  ): TradingSignal[] {
    if (!this.isActive) return [];
    const currentPrice = marketData.price;
    if (this.state === "initializing") {
      return this.initializeGrid(currentPrice, balance);
    }
    if (this.state === "active" && this.shouldRebalance(currentPrice)) {
      return this.rebalanceGrid(currentPrice, balance);
    }
    return [];
  }

  private initializeGrid(currentPrice: number, balance: number): TradingSignal[] {
    this.centerPrice = currentPrice;
    let min: number;
    let max: number;
    if (this.grid.minPrice !== undefined && this.grid.maxPrice !== undefined) {
      min = this.grid.minPrice;
      max = this.grid.maxPrice;
    } else {
      const r = currentPrice * (this.grid.rangePct / 100);
      min = currentPrice - r;
      max = currentPrice + r;
    }
    this.levels = this.createLevels(min, max, currentPrice);
    const signals: TradingSignal[] = [];
    for (const L of this.levels) {
      if (L.isBuyLevel && L.price < currentPrice) {
        signals.push({
          signalType: SignalType.BUY,
          asset: this.grid.symbol,
          size: L.size,
          price: L.price,
          reason: `Grid buy at ${L.price.toFixed(2)}`,
          metadata: { levelIndex: L.levelIndex, gridType: "initial" },
        });
      } else if (!L.isBuyLevel && L.price > currentPrice) {
        signals.push({
          signalType: SignalType.SELL,
          asset: this.grid.symbol,
          size: L.size,
          price: L.price,
          reason: `Grid sell at ${L.price.toFixed(2)}`,
          metadata: { levelIndex: L.levelIndex, gridType: "initial" },
        });
      }
    }
    this.state = "active";
    return signals;
  }

  private createLevels(min: number, max: number, currentPrice: number): Level[] {
    const n = this.grid.levels;
    const usdPer = this.grid.totalAllocation / n;
    const ratio = n > 1 ? (max / min) ** (1 / (n - 1)) : 1;
    const out: Level[] = [];
    for (let i = 0; i < n; i++) {
      const price = min * ratio ** i;
      const sizeBtc = usdPer / price;
      const isBuyLevel = price < currentPrice;
      out.push({
        price,
        size: sizeBtc,
        levelIndex: i,
        isBuyLevel,
        isFilled: false,
      });
    }
    return out;
  }

  private shouldRebalance(currentPrice: number): boolean {
    if (this.centerPrice === null) return false;
    const move = (Math.abs(currentPrice - this.centerPrice) / this.centerPrice) * 100;
    return move > this.grid.rebalanceThresholdPct;
  }

  private rebalanceGrid(currentPrice: number, balance: number): TradingSignal[] {
    this.state = "rebalancing";
    const cancel: TradingSignal = {
      signalType: SignalType.CLOSE,
      asset: this.grid.symbol,
      size: 0,
      reason: "Rebalancing grid",
      metadata: { action: "cancel_all" },
    };
    this.state = "initializing";
    const next = this.initializeGrid(currentPrice, balance);
    this.lastRebalance = Date.now() / 1000;
    return [cancel, ...next];
  }

  onTradeExecuted(
    signal: TradingSignal,
    executedPrice: number,
    executedSize: number,
  ): void {
    this.totalTrades += 1;
    const idx = signal.metadata.levelIndex;
    if (typeof idx === "number" && idx < this.levels.length) {
      this.levels[idx]!.isFilled = true;
    }
    if (signal.signalType === SignalType.SELL) {
      const buyPrice = executedPrice * 0.99;
      this.totalProfit += (executedPrice - buyPrice) * executedSize;
    }
  }

  onError(_error: unknown, _context: Record<string, unknown>): void {}

  getStatus(): Record<string, unknown> {
    const activeLevels = this.levels.filter((l) => !l.isFilled).length;
    return {
      name: this.name,
      active: this.isActive,
      state: this.state,
      centerPrice: this.centerPrice,
      totalLevels: this.levels.length,
      activeLevels,
      totalTrades: this.totalTrades,
      totalProfit: this.totalProfit,
      lastRebalance: this.lastRebalance,
    };
  }
}

