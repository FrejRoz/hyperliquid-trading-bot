import type { Position } from "./strategy.js";

export enum OrderSide {
  BUY = "buy",
  SELL = "sell",
}

export enum OrderType {
  MARKET = "market",
  LIMIT = "limit",
}

export enum OrderStatus {
  PENDING = "pending",
  SUBMITTED = "submitted",
  PARTIALLY_FILLED = "partially_filled",
  FILLED = "filled",
  CANCELLED = "cancelled",
  REJECTED = "rejected",
}

export type Order = {
  id: string;
  asset: string;
  side: OrderSide;
  size: number;
  orderType: OrderType;
  price?: number;
  status: OrderStatus;
  filledSize: number;
  averageFillPrice: number;
  exchangeOrderId?: string;
  createdAt: number;
};

export type Balance = {
  asset: string;
  available: number;
  locked: number;
  total: number;
};

export type MarketInfo = {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  minOrderSize: number;
  pricePrecision: number;
  sizePrecision: number;
  isActive: boolean;
};

export interface ExchangeAdapter {
  readonly exchangeName: string;
  isConnected: boolean;
  connect(): Promise<boolean>;
  disconnect(): Promise<void>;
  getBalance(asset: string): Promise<Balance>;
  getMarketPrice(asset: string): Promise<number>;
  placeOrder(order: Order): Promise<string>;
  cancelOrder(exchangeOrderId: string): Promise<boolean>;
  getOrderStatus(exchangeOrderId: string): Promise<Order>;
  getMarketInfo(asset: string): Promise<MarketInfo>;
  getPositions(): Promise<Position[]>;
  closePosition(asset: string, size?: number): Promise<boolean>;
  getAccountMetrics(): Promise<Record<string, number>>;
  getOpenOrders(): Promise<Order[]>;
  cancelAllOrders(): Promise<number>;
  getStatus(): Record<string, unknown>;
  healthCheck(): Promise<boolean>;
}
