import WebSocket from "ws";
import type { MarketData } from "../../interfaces/strategy.js";

const wsUrl = (testnet: boolean) =>
  testnet ? "wss://api.hyperliquid-testnet.xyz/ws" : "wss://api.hyperliquid.xyz/ws";

type PriceCallback = (m: MarketData) => void | Promise<void>;

export class HyperliquidMarketData {
  private ws: WebSocket | null = null;
  private running = false;
  private readonly subscribed = new Set<string>();
  private readonly callbacks = new Map<string, PriceCallback[]>();
  private latest = new Map<string, MarketData>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private wasOpen = false;

  constructor(
    private readonly testnet: boolean,
    private readonly opts: { reconnectDelaySec?: number; maxReconnectAttempts?: number } = {},
  ) {
    this.opts.reconnectDelaySec ??= 5;
    this.opts.maxReconnectAttempts ??= 10;
  }

  async connect(): Promise<boolean> {
    this.running = true;
    return this.openSocket();
  }

  private openSocket(): Promise<boolean> {
    return new Promise((resolve) => {
      const url = wsUrl(this.testnet);
      let settled = false;
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        resolve(ok);
      };
      try {
        this.ws = new WebSocket(url);
      } catch (e) {
        console.error("WebSocket create failed:", e);
        finish(false);
        return;
      }

      this.ws.once("open", () => {
        this.reconnectAttempts = 0;
        this.wasOpen = true;
        console.log(`WebSocket open (${this.testnet ? "testnet" : "mainnet"}) ${url}`);
        this.sendSubscribe();
        finish(true);
      });

      this.ws.on("message", (data: WebSocket.RawData) => {
        void this.onFrame(data);
      });

      this.ws.on("error", (err) => {
        console.error("WebSocket error:", err);
        finish(false);
      });

      this.ws.on("close", () => {
        this.ws = null;
        if (!this.running) return;
        if (this.wasOpen) this.scheduleReconnect();
      });
    });
  }

  private scheduleReconnect(): void {
    if (!this.running) return;
    if (this.reconnectAttempts >= (this.opts.maxReconnectAttempts ?? 10)) {
      console.error("WebSocket: max reconnection attempts reached");
      return;
    }
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      void this.openSocket();
    }, (this.opts.reconnectDelaySec ?? 5) * 1000);
  }

  private sendSubscribe(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const msg = JSON.stringify({ method: "subscribe", subscription: { type: "allMids" } });
    this.ws.send(msg);
  }

  private async onFrame(data: WebSocket.RawData): Promise<void> {
    try {
      const text = typeof data === "string" ? data : data.toString("utf8");
      const j = JSON.parse(text) as Record<string, unknown>;
      if (j.channel !== "allMids") return;
      const d = j.data as { mids?: Record<string, string> } | undefined;
      const mids = d?.mids ?? {};
      const ts = Date.now() / 1000;
      for (const asset of this.subscribed) {
        const pstr = mids[asset];
        if (pstr === undefined) continue;
        const price = parseFloat(pstr);
        if (Number.isNaN(price)) continue;
        const md: MarketData = { asset, price, volume24h: 0, timestamp: ts };
        this.latest.set(asset, md);
        for (const cb of this.callbacks.get(asset) ?? []) {
          try {
            await Promise.resolve(cb(md));
          } catch (e) {
            console.error("Price callback error:", e);
          }
        }
      }
    } catch {
      // ignore
    }
  }

  async disconnect(): Promise<void> {
    this.running = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
  }

  async subscribePriceUpdates(asset: string, callback: PriceCallback): Promise<void> {
    if (!this.callbacks.has(asset)) this.callbacks.set(asset, []);
    this.callbacks.get(asset)!.push(callback);
    this.subscribed.add(asset);
    this.sendSubscribe();
  }

  getLatestPrice(asset: string): number | undefined {
    return this.latest.get(asset)?.price;
  }

  getStatus(): Record<string, unknown> {
    return {
      connected: this.ws !== null && this.ws.readyState === WebSocket.OPEN,
      subscribedAssets: [...this.subscribed],
      latestDataCount: this.latest.size,
    };
  }
}
