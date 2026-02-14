import {
  ExchangeClient,
  HttpTransport,
  InfoClient,
} from "@nktkas/hyperliquid";
import { privateKeyToAccount } from "viem/accounts";
import type { ExchangeAdapter } from "../../interfaces/exchange.js";
import {
  Balance,
  Order,
  OrderSide,
  OrderStatus,
  OrderType,
  MarketInfo,
} from "../../interfaces/exchange.js";
import type { Position } from "../../interfaces/strategy.js";

function extractOrderId(res: {
  response?: { data?: { statuses?: unknown[] } };
}): string {
  const st = res.response?.data?.statuses?.[0];
  if (st && typeof st === "object") {
    if ("resting" in st && st.resting && typeof st.resting === "object" && "oid" in st.resting) {
      return String((st as { resting: { oid: number } }).resting.oid);
    }
    if ("filled" in st && st.filled && typeof st.filled === "object" && "oid" in st.filled) {
      return String((st as { filled: { oid: number } }).filled.oid);
    }
  }
  throw new Error(`Unexpected order response: ${JSON.stringify(res)}`);
}

export class HyperliquidAdapter implements ExchangeAdapter {
  exchangeName = "Hyperliquid";
  isConnected = false;
  private transport!: HttpTransport;
  private info!: InfoClient;
  private exchange!: ExchangeClient;
  private address!: `0x${string}`;
  private assetToIndex = new Map<string, number>();
  private szDecimalsByName = new Map<string, number>();

  constructor(
    private readonly privateKey: string,
    private readonly testnet: boolean,
  ) {}

  async connect(): Promise<boolean> {
    try {
      this.transport = new HttpTransport({ isTestnet: this.testnet });
      const account = privateKeyToAccount(this.privateKey as `0x${string}`);
      this.address = account.address;
      this.info = new InfoClient({ transport: this.transport });
      this.exchange = new ExchangeClient({ transport: this.transport, wallet: account });

      const meta = await this.info.meta();
      meta.universe.forEach((u, i) => {
        this.assetToIndex.set(u.name, i);
        this.szDecimalsByName.set(u.name, u.szDecimals);
      });

      await this.info.clearinghouseState({ user: this.address });

      this.isConnected = true;
      return true;
    } catch (e) {
      console.error("Failed to connect to Hyperliquid:", e);
      this.isConnected = false;
      return false;
    }
  }

  async disconnect(): Promise<void> {
    this.isConnected = false;
  }

  getStatus(): Record<string, unknown> {
    return { exchange: this.exchangeName, connected: this.isConnected, testnet: this.testnet };
  }

  private requireAssetIndex(name: string): number {
    const i = this.assetToIndex.get(name);
    if (i === undefined) throw new Error(`Unknown asset: ${name}`);
    return i;
  }

  private roundPrice(name: string, price: number): string {
    if (name === "BTC") {
      return String(Math.round(price));
    }
    return String(Math.round(price * 100) / 100);
  }

  private roundSize(name: string, size: number): string {
    const d = this.szDecimalsByName.get(name) ?? 5;
    const f = 10 ** d;
    return String(Math.max(Number((Math.floor(size * f) / f).toFixed(d)), 1 / f));
  }

  async getBalance(asset: string): Promise<Balance> {
    if (!this.isConnected) throw new Error("Not connected");
    const st = await this.info.clearinghouseState({ user: this.address });
    if (asset === "USD" || asset === "USDC") {
      const total = parseFloat(st.crossMarginSummary.accountValue);
      const avail = parseFloat(st.withdrawable);
      return {
        asset: "USD",
        available: avail,
        locked: Math.max(0, total - avail),
        total,
      };
    }
    return { asset, available: 0, locked: 0, total: 0 };
  }

  async getMarketPrice(asset: string): Promise<number> {
    if (!this.isConnected) throw new Error("Not connected");
    const mids = await this.info.allMids();
    const p = mids[asset];
    if (!p) throw new Error(`No mid for ${asset}`);
    return parseFloat(p);
  }

  async placeOrder(order: Order): Promise<string> {
    if (!this.isConnected) throw new Error("Not connected");
    const a = this.requireAssetIndex(order.asset);
    const isBuy = order.side === OrderSide.BUY;
    const sz = this.roundSize(order.asset, order.size);
    if (order.orderType === OrderType.MARKET) {
      const mp = await this.getMarketPrice(order.asset);
      const adj = isBuy ? mp * 1.01 : mp * 0.99;
      const px = this.roundPrice(order.asset, adj);
      const res = await this.exchange.order({
        orders: [
          {
            a,
            b: isBuy,
            p: px,
            s: sz,
            r: false,
            t: { limit: { tif: "Ioc" } },
          },
        ],
        grouping: "na",
      });
      return extractOrderId(res);
    }
    const px = this.roundPrice(order.asset, order.price ?? 0);
    const res = await this.exchange.order({
      orders: [
        {
          a,
          b: isBuy,
          p: px,
          s: sz,
          r: false,
          t: { limit: { tif: "Gtc" } },
        },
      ],
      grouping: "na",
    });
    return extractOrderId(res);
  }

  async cancelOrder(exchangeOrderId: string): Promise<boolean> {
    if (!this.isConnected) return false;
    const oid = Number(exchangeOrderId);
    const open = await this.info.openOrders({ user: this.address });
    const found = open.find((o) => o.oid === oid);
    if (!found) return false;
    const a = this.requireAssetIndex(found.coin);
    const res = await this.exchange.cancel({ cancels: [{ a, o: oid }] });
    const st = res.response?.data?.statuses?.[0];
    return st === "success";
  }

  async getOrderStatus(exchangeOrderId: string): Promise<Order> {
    return {
      id: exchangeOrderId,
      asset: "BTC",
      side: OrderSide.BUY,
      size: 0,
      orderType: OrderType.LIMIT,
      status: OrderStatus.SUBMITTED,
      filledSize: 0,
      averageFillPrice: 0,
      exchangeOrderId,
      createdAt: Date.now() / 1000,
    };
  }

  async getMarketInfo(asset: string): Promise<MarketInfo> {
    const meta = await this.info.meta();
    const u = meta.universe.find((x) => x.name === asset);
    if (!u) throw new Error(`Unknown asset ${asset}`);
    return {
      symbol: asset,
      baseAsset: asset,
      quoteAsset: "USD",
      minOrderSize: 10 ** -u.szDecimals,
      pricePrecision: 8,
      sizePrecision: u.szDecimals,
      isActive: u.isDelisted !== true,
    };
  }

  async getOpenOrders(): Promise<Order[]> {
    if (!this.isConnected) return [];
    const open = await this.info.openOrders({ user: this.address });
    return open.map((o) => ({
      id: String(o.oid),
      asset: o.coin,
      side: o.side === "B" ? OrderSide.BUY : OrderSide.SELL,
      size: parseFloat(o.sz),
      orderType: OrderType.LIMIT,
      price: parseFloat(o.limitPx),
      status: OrderStatus.SUBMITTED,
      filledSize: 0,
      averageFillPrice: 0,
      exchangeOrderId: String(o.oid),
      createdAt: o.timestamp / 1000,
    }));
  }

  async healthCheck(): Promise<boolean> {
    if (!this.isConnected) return false;
    try {
      await this.info.clearinghouseState({ user: this.address });
      return true;
    } catch {
      return false;
    }
  }

  async getPositions(): Promise<Position[]> {
    if (!this.isConnected) return [];
    const st = await this.info.clearinghouseState({ user: this.address });
    const out: Position[] = [];
    for (const ap of st.assetPositions) {
      const szi = parseFloat(ap.position.szi);
      if (szi === 0) continue;
      const coin = ap.position.coin;
      const entryPx = parseFloat(ap.position.entryPx);
      const px = await this.getMarketPrice(coin);
      const currentValue = Math.abs(szi) * px;
      const unreal = parseFloat(ap.position.unrealizedPnl);
      out.push({
        asset: coin,
        size: szi,
        entryPrice: entryPx,
        currentValue,
        unrealizedPnl: unreal,
        timestamp: Date.now() / 1000,
      });
    }
    return out;
  }

  async closePosition(asset: string, size?: number): Promise<boolean> {
    if (!this.isConnected) return false;
    const positions = await this.getPositions();
    const pos = positions.find((p) => p.asset === asset);
    if (!pos) return false;
    const closeSize = size !== undefined ? Math.min(size, Math.abs(pos.size)) : Math.abs(pos.size);
    const a = this.requireAssetIndex(asset);
    const isBuy = pos.size < 0;
    const mp = await this.getMarketPrice(asset);
    const adj = isBuy ? mp * 1.01 : mp * 0.99;
    const px = this.roundPrice(asset, adj);
    const res = await this.exchange.order({
      orders: [
        {
          a,
          b: isBuy,
          p: px,
          s: this.roundSize(asset, closeSize),
          r: true,
          t: { limit: { tif: "Ioc" } },
        },
      ],
      grouping: "na",
    });
    try {
      extractOrderId(res);
      return true;
    } catch {
      return false;
    }
  }

  async getAccountMetrics(): Promise<{
    totalValue: number;
    totalPnl: number;
    unrealizedPnl: number;
    realizedPnl: number;
    drawdownPct: number;
    positionsCount: number;
    largestPositionPct: number;
  }> {
    if (!this.isConnected) {
      return {
        totalValue: 0,
        totalPnl: 0,
        unrealizedPnl: 0,
        realizedPnl: 0,
        drawdownPct: 0,
        positionsCount: 0,
        largestPositionPct: 0,
      };
    }
    const st = await this.info.clearinghouseState({ user: this.address });
    const totalValue = parseFloat(st.crossMarginSummary.accountValue);
    const positions = await this.getPositions();
    const positionPnl = positions.reduce((s, p) => s + p.unrealizedPnl, 0);
    const uPnl = parseFloat(st.crossMarginSummary.totalRawUsd);
    const drawdownPct =
      totalValue > 0 && positionPnl < 0 ? (Math.max(0, -positionPnl) / totalValue) * 100 : 0;
    const largest =
      totalValue > 0
        ? Math.max(0, ...positions.map((p) => (p.currentValue / totalValue) * 100))
        : 0;
    return {
      totalValue,
      totalPnl: positionPnl,
      unrealizedPnl: uPnl,
      realizedPnl: 0,
      drawdownPct,
      positionsCount: positions.length,
      largestPositionPct: largest,
    };
  }

  async cancelAllOrders(): Promise<number> {
    const orders = await this.getOpenOrders();
    let n = 0;
    for (const o of orders) {
      if (o.exchangeOrderId && (await this.cancelOrder(o.exchangeOrderId))) n += 1;
    }
    return n;
  }
}
