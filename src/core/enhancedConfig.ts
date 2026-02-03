import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import type { Logger } from "pino";

export type ExchangeYaml = {
  type: string;
  testnet: boolean;
};

export type AccountYaml = {
  max_allocation_pct: number;
  risk_level?: string;
};

export type RebalanceYaml = {
  price_move_threshold_pct: number;
  time_based?: boolean;
  cooldown_minutes?: number;
  max_rebalances_per_day?: number;
};

export type RiskManagementYaml = {
  max_drawdown_pct: number;
  max_position_size_pct: number;
  stop_loss_enabled: boolean;
  stop_loss_pct: number;
  take_profit_enabled: boolean;
  take_profit_pct: number;
  rebalance: RebalanceYaml;
};

export type MarketDataYaml = {
  volatility_window_hours: number;
  connection_retry_attempts: number;
  connection_timeout_sec: number;
  websocket_reconnect_delay_sec: number;
};

export type MonitoringYaml = {
  log_level: "DEBUG" | "INFO" | "WARNING" | "ERROR";
  report_interval_minutes: number;
  save_trade_history: boolean;
  metrics_export: boolean;
};

export type AutoPriceRangeYaml = {
  range_pct: number;
  volatility_adjustment?: boolean;
  min_range_pct?: number;
  max_range_pct?: number;
  volatility_multiplier?: number;
};

export type PriceRangeYaml = {
  mode: "auto" | "manual";
  auto: AutoPriceRangeYaml;
  manual?: { min: number; max: number };
};

export type GridYaml = {
  symbol: string;
  levels: number;
  price_range: PriceRangeYaml;
  position_sizing?: unknown;
};

export type EnhancedBotConfig = {
  name: string;
  active: boolean;
  exchange: ExchangeYaml;
  account: AccountYaml;
  grid: GridYaml;
  risk_management: RiskManagementYaml;
  market_data: MarketDataYaml;
  monitoring: MonitoringYaml;
  private_key?: string;
  testnet_private_key?: string;
  mainnet_private_key?: string;
  private_key_file?: string;
  testnet_key_file?: string;
  mainnet_key_file?: string;
};

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

export class EnhancedConfigLoader {
  static fromYaml(filePath: string, logger?: Logger): EnhancedBotConfig {
    const raw = fs.readFileSync(path.resolve(filePath), "utf8");
    const data = yaml.load(raw) as unknown;
    if (!isRecord(data)) throw new Error("Invalid YAML root");
    return this.parse(data, logger);
  }

  private static parse(data: Record<string, unknown>, logger?: Logger): EnhancedBotConfig {
    const name = data.name;
    if (typeof name !== "string" || !name) throw new Error("Bot name is required");

    const ex = isRecord(data.exchange) ? data.exchange : {};
    const exchange: ExchangeYaml = {
      type: typeof ex.type === "string" ? ex.type : "hyperliquid",
      testnet: ex.testnet !== false,
    };

    const acc = isRecord(data.account) ? data.account : {};
    const maxAllocation =
      typeof acc.max_allocation_pct === "number" ? acc.max_allocation_pct : 20;
    if (maxAllocation < 1 || maxAllocation > 100) {
      throw new Error("max_allocation_pct must be 1-100");
    }
    const account: AccountYaml = {
      max_allocation_pct: maxAllocation,
      risk_level: typeof acc.risk_level === "string" ? acc.risk_level : "moderate",
    };

    const g = isRecord(data.grid) ? data.grid : {};
    const pr = isRecord(g.price_range) ? g.price_range : {};
    const auto = isRecord(pr.auto) ? pr.auto : {};
    const grid: GridYaml = {
      symbol: typeof g.symbol === "string" ? g.symbol : "BTC",
      levels: typeof g.levels === "number" ? g.levels : 10,
      price_range: {
        mode: pr.mode === "manual" ? "manual" : "auto",
        auto: {
          range_pct: typeof auto.range_pct === "number" ? auto.range_pct : 10,
        },
        manual:
          isRecord(pr.manual) && typeof pr.manual.min === "number" && typeof pr.manual.max === "number"
            ? { min: pr.manual.min, max: pr.manual.max }
            : undefined,
      },
    };
    if (grid.levels < 3 || grid.levels > 50) {
      throw new Error("grid.levels must be 3-50");
    }

    const rm = isRecord(data.risk_management) ? data.risk_management : {};
    const reb = isRecord(rm.rebalance) ? rm.rebalance : {};
    const risk_management: RiskManagementYaml = {
      max_drawdown_pct: typeof rm.max_drawdown_pct === "number" ? rm.max_drawdown_pct : 15,
      max_position_size_pct:
        typeof rm.max_position_size_pct === "number" ? rm.max_position_size_pct : 30,
      stop_loss_enabled: rm.stop_loss_enabled === true,
      stop_loss_pct: typeof rm.stop_loss_pct === "number" ? rm.stop_loss_pct : 5,
      take_profit_enabled: rm.take_profit_enabled === true,
      take_profit_pct: typeof rm.take_profit_pct === "number" ? rm.take_profit_pct : 20,
      rebalance: {
        price_move_threshold_pct:
          typeof reb.price_move_threshold_pct === "number" ? reb.price_move_threshold_pct : 15,
      },
    };

    const md = isRecord(data.market_data) ? data.market_data : {};
    const market_data: MarketDataYaml = {
      volatility_window_hours:
        typeof md.volatility_window_hours === "number" ? md.volatility_window_hours : 24,
      connection_retry_attempts:
        typeof md.connection_retry_attempts === "number" ? md.connection_retry_attempts : 3,
      connection_timeout_sec:
        typeof md.connection_timeout_sec === "number" ? md.connection_timeout_sec : 10,
      websocket_reconnect_delay_sec:
        typeof md.websocket_reconnect_delay_sec === "number"
          ? md.websocket_reconnect_delay_sec
          : 5,
    };

    const mon = isRecord(data.monitoring) ? data.monitoring : {};
    const logLevel = mon.log_level;
    const monitoring: MonitoringYaml = {
      log_level:
        logLevel === "DEBUG" || logLevel === "WARNING" || logLevel === "ERROR"
          ? logLevel
          : "INFO",
      report_interval_minutes:
        typeof mon.report_interval_minutes === "number" ? mon.report_interval_minutes : 60,
      save_trade_history: mon.save_trade_history === true,
      metrics_export: mon.metrics_export === true,
    };

    const hasInlineKey = [data.private_key, data.testnet_private_key, data.mainnet_private_key].some(
      (k) => typeof k === "string" && k.length > 0,
    );
    if (hasInlineKey) {
      logger?.warn("Private keys in YAML are insecure; prefer environment variables or key files");
    }

    return {
      name,
      active: data.active === true,
      exchange,
      account,
      grid,
      risk_management,
      market_data,
      monitoring,
      private_key: typeof data.private_key === "string" ? data.private_key : undefined,
      testnet_private_key:
        typeof data.testnet_private_key === "string" ? data.testnet_private_key : undefined,
      mainnet_private_key:
        typeof data.mainnet_private_key === "string" ? data.mainnet_private_key : undefined,
      private_key_file: typeof data.private_key_file === "string" ? data.private_key_file : undefined,
      testnet_key_file: typeof data.testnet_key_file === "string" ? data.testnet_key_file : undefined,
      mainnet_key_file: typeof data.mainnet_key_file === "string" ? data.mainnet_key_file : undefined,
    };
  }

  static validate(c: EnhancedBotConfig): void {
    if (c.risk_management.max_drawdown_pct < 5 || c.risk_management.max_drawdown_pct > 50) {
      throw new Error("max_drawdown_pct must be 5-50");
    }
  }
}
