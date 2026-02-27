import pino, { type Logger } from "pino";
import type { ExchangeAdapter } from "../interfaces/exchange.js";
import {
  Order,
  OrderSide,
  OrderStatus,
  OrderType,
} from "../interfaces/exchange.js";
import type { MarketData, Position, TradingSignal, TradingStrategy } from "../interfaces/strategy.js";
import { SignalType } from "../interfaces/strategy.js";
import { HyperliquidMarketData } from "../exchanges/hyperliquid/marketData.js";
import { createExchangeAdapter } from "../exchanges/createAdapter.js";
import { createStrategy } from "../strategies/createStrategy.js";
import { keyManager } from "./keyManager.js";
import { RiskManager, RiskAction, type AccountMetrics, type RiskEvent } from "./riskManager.js";
import type { RiskManagementYaml } from "./enhancedConfig.js";

type EngineConfig = {
  exchange: { type: string; testnet: boolean };
  strategy: Record<string, unknown>;
  bot_config: Record<string, string | undefined>;
  log_level: string;
  risk_management: RiskManagementYaml;
};

export class TradingEngine {
  private config: EngineConfig;
  private running = false;
  private strategy: TradingStrategy | null = null;
  private exchange: ExchangeAdapter | null = null;
  private marketData: HyperliquidMarketData | null = null;
  private riskManager: RiskManager | null = null;
  private currentPositions: Position[] = [];
  private pendingOrders: Map<string, Order> = new Map();
  private executedTrades = 0;
  private totalPnl = 0;
  private logger: Logger;
  private loop: Promise<void> | null = null;

  constructor(config: EngineConfig) {
    this.config = config;
    this.logger = pino({ level: (config.log_level || "INFO").toLowerCase() as pino.Level });
  }

  async initialize(): Promise<boolean> {
    try {
      this.logger.info("Initializing trading engine");
      if (!(await this.initExchange())) return false;
      if (!(await this.initMarketData())) return false;
      if (!this.initStrategy()) return false;
      this.initRisk();
      this.logger.info("Trading engine initialized");
      return true;
    } catch (e) {
      this.logger.error({ err: e }, "Init failed");
      return false;
    }
  }

  private async initExchange(): Promise<boolean> {
    const ex = this.config.exchange;
    const pk = keyManager.getPrivateKey(ex.testnet, this.config.bot_config);
    try {
      this.exchange = createExchangeAdapter(ex.type, { private_key: pk, testnet: ex.testnet });
      const ok = await this.exchange.connect();
      if (ok) this.logger.info("Exchange connected");
      return ok;
    } catch (e) {
      this.logger.error({ err: e }, "Exchange init failed");
      return false;
    }
  }

  private async initMarketData(): Promise<boolean> {
    const testnet = this.config.exchange.testnet;
    this.marketData = new HyperliquidMarketData(testnet);
    const ok = await this.marketData.connect();
    if (ok) this.logger.info("Market data connected");
    return ok;
  }

  private initStrategy(): boolean {
    try {
      const t = (this.config.strategy.type as string) || "basic_grid";
      this.strategy = createStrategy(t, this.config.strategy);
      this.strategy.start();
      this.logger.info({ strategy: t }, "Strategy ready");
      return true;
    } catch (e) {
      this.logger.error({ err: e }, "Strategy init failed");
      return false;
    }
  }

  private initRisk(): void {
    this.riskManager = new RiskManager({ risk_management: this.config.risk_management });
    this.logger.info("Risk manager ready");
  }

  async start(): Promise<void> {
    if (!this.strategy || !this.exchange || !this.marketData) {
      throw new Error("Engine not initialized");
    }
    this.running = true;
    this.logger.info("Engine started");
    const asset = (this.config.strategy.symbol as string) || "BTC";
    await this.marketData.subscribePriceUpdates(asset, (md) => {
      void this.handlePriceUpdate(md);
    });
    this.loop = this.tradingLoop();
    await this.loop;
  }

  async stop(): Promise<void> {
    this.running = false;
    this.logger.info("Stopping engine");
    if (this.strategy) this.strategy.stop();
    if (this.exchange) {
      try {
        const n = await this.exchange.cancelAllOrders();
        if (n > 0) this.logger.info({ cancelled: n }, "Cancelled open orders");
      } catch (e) {
        this.logger.error({ err: e }, "Cancel on shutdown failed");
      }
      await this.exchange.disconnect();
    }
    if (this.marketData) await this.marketData.disconnect();
    this.logger.info("Engine stopped");
  }

  private async handlePriceUpdate(marketData: MarketData): Promise<void> {
    if (!this.running || !this.strategy || !this.exchange) return;
    try {
      this.currentPositions = await this.exchange.getPositions();
      const bal = await this.exchange.getBalance("USD");
      const balance = bal.available;
      if (this.riskManager) {
        await this.handleRisks(marketData);
      }
      const signals = this.strategy.generateSignals(marketData, this.currentPositions, balance);
      for (const s of signals) {
        await this.executeSignal(s);
      }
    } catch (e) {
      this.logger.error({ err: e }, "handlePriceUpdate");
    }
  }

  private async handleRisks(marketData: MarketData): Promise<void> {
    if (!this.riskManager || !this.exchange) return;
    try {
      const raw = await this.exchange.getAccountMetrics();
      const accountMetrics: AccountMetrics = {
        totalValue: raw.totalValue,
        totalPnl: raw.totalPnl,
        unrealizedPnl: raw.unrealizedPnl,
        realizedPnl: raw.realizedPnl,
        drawdownPct: raw.drawdownPct,
        positionsCount: raw.positionsCount,
        largestPositionPct: raw.largestPositionPct,
      };
      const mdMap: Record<string, MarketData> = { [marketData.asset]: marketData };
      const events = this.riskManager.evaluateRisks(this.currentPositions, mdMap, accountMetrics);
      for (const ev of events) {
        await this.executeRiskAction(ev);
      }
    } catch (e) {
      this.logger.error({ err: e }, "handleRisks");
    }
  }

  private async executeRiskAction(event: RiskEvent): Promise<void> {
    if (!this.exchange || !this.strategy) return;
    this.logger.warn({ event }, "Risk event");
    try {
      if (event.action === RiskAction.CLOSE_POSITION) {
        await this.exchange.closePosition(event.asset);
      } else if (event.action === RiskAction.REDUCE_POSITION) {
        const positions = await this.exchange.getPositions();
        const p = positions.find((x) => x.asset === event.asset);
        if (p) {
          const reduce = Math.abs(p.size) * 0.5;
          await this.exchange.closePosition(event.asset, reduce);
        }
      } else if (event.action === RiskAction.CANCEL_ORDERS) {
        await this.exchange.cancelAllOrders();
      } else if (event.action === RiskAction.PAUSE_TRADING) {
        this.strategy.isActive = false;
      } else if (event.action === RiskAction.EMERGENCY_EXIT) {
        const pos = await this.exchange.getPositions();
        for (const x of pos) {
          await this.exchange.closePosition(x.asset);
        }
        await this.exchange.cancelAllOrders();
        this.strategy.isActive = false;
      }
    } catch (e) {
      this.logger.error({ err: e, rule: event.ruleName }, "executeRiskAction");
    }
  }

  private async executeSignal(signal: TradingSignal): Promise<void> {
    if (!this.exchange || !this.strategy) return;
    try {
      if (signal.signalType === SignalType.BUY || signal.signalType === SignalType.SELL) {
        await this.placeOrder(signal);
      } else if (signal.signalType === SignalType.CLOSE) {
        await this.closeForSignal(signal);
      }
    } catch (e) {
      this.logger.error({ err: e }, "executeSignal");
      this.strategy?.onError(e, { signal });
    }
  }

  private async placeOrder(signal: TradingSignal): Promise<void> {
    if (!this.exchange || !this.strategy) return;
    const now = Date.now() / 1000;
    const order: Order = {
      id: `order_${Date.now()}`,
      asset: signal.asset,
      side: signal.signalType === SignalType.BUY ? OrderSide.BUY : OrderSide.SELL,
      size: signal.size,
      orderType: signal.price ? OrderType.LIMIT : OrderType.MARKET,
      price: signal.price,
      status: OrderStatus.SUBMITTED,
      filledSize: 0,
      averageFillPrice: 0,
      createdAt: now,
    };
    const exId = await this.exchange.placeOrder(order);
    order.exchangeOrderId = exId;
    this.pendingOrders.set(order.id, order);
    this.logger.info(
      { side: order.side, size: order.size, asset: order.asset, price: order.price },
      "Placed order",
    );
    const execPrice = order.price ?? 0;
    this.strategy.onTradeExecuted(signal, execPrice, order.size);
    this.executedTrades += 1;
  }

  private async closeForSignal(signal: TradingSignal): Promise<void> {
    if (!this.exchange) return;
    if (signal.metadata.action === "cancel_all") {
      const n = await this.exchange.cancelAllOrders();
      this.logger.info({ n }, "Cancelled for rebalance");
    }
  }

  private async tradingLoop(): Promise<void> {
    let tick = 0;
    while (this.running) {
      await new Promise((r) => setTimeout(r, 1000));
      if (!this.running) break;
      tick += 1;
      if (tick < 60) continue;
      tick = 0;
      const now = Date.now() / 1000;
      for (const [id, o] of this.pendingOrders) {
        if (now - o.createdAt > 3600) this.pendingOrders.delete(id);
      }
      if (this.executedTrades > 0) {
        this.logger.info({ executedTrades: this.executedTrades }, "Status");
      }
    }
  }

  getStatus(): Record<string, unknown> {
    return {
      running: this.running,
      strategy: this.strategy?.getStatus() ?? null,
      exchange: this.exchange?.getStatus() ?? null,
      marketData: this.marketData?.getStatus() ?? null,
      risk: this.riskManager?.getStatus() ?? null,
      executedTrades: this.executedTrades,
      totalPnl: this.totalPnl,
    };
  }
}
