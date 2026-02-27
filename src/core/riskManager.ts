import type { MarketData, Position } from "../interfaces/strategy.js";

export enum RiskAction {
  NONE = "none",
  CLOSE_POSITION = "close_position",
  REDUCE_POSITION = "reduce_position",
  CANCEL_ORDERS = "cancel_orders",
  PAUSE_TRADING = "pause_trading",
  EMERGENCY_EXIT = "emergency_exit",
}

export type RiskEvent = {
  ruleName: string;
  asset: string;
  action: RiskAction;
  reason: string;
  severity: string;
  metadata: Record<string, unknown>;
  timestamp: number;
};

export type AccountMetrics = {
  totalValue: number;
  totalPnl: number;
  unrealizedPnl: number;
  realizedPnl: number;
  drawdownPct: number;
  positionsCount: number;
  largestPositionPct: number;
};

type RiskRule = {
  name: string;
  enabled: boolean;
  evaluate(
    positions: Position[],
    marketData: Record<string, MarketData>,
    accountMetrics: AccountMetrics,
  ): RiskEvent[];
};

type RiskManagementYaml = {
  max_drawdown_pct?: number;
  max_position_size_pct?: number;
  stop_loss_enabled?: boolean;
  stop_loss_pct?: number;
  take_profit_enabled?: boolean;
  take_profit_pct?: number;
};

function stopLossRule(lossPct: number, ruleEnabled: boolean): RiskRule {
  return {
    name: "stop_loss",
    enabled: ruleEnabled,
    evaluate(positions, _market, _acct) {
      if (!ruleEnabled) return [];
      const events: RiskEvent[] = [];
      for (const position of positions) {
        if (position.entryPrice <= 0) continue;
        const lossPctVal =
          (Math.abs(position.unrealizedPnl) / (position.entryPrice * Math.abs(position.size))) *
          100;
        if (lossPctVal >= lossPct) {
          events.push({
            ruleName: "stop_loss",
            asset: position.asset,
            action: RiskAction.CLOSE_POSITION,
            reason: `Stop loss: ${lossPctVal.toFixed(2)}% >= ${lossPct}%`,
            severity: "HIGH",
            metadata: {
              positionSize: position.size,
              entryPrice: position.entryPrice,
              currentLossPct: lossPctVal,
              thresholdPct: lossPct,
              unrealizedPnl: position.unrealizedPnl,
            },
            timestamp: Date.now() / 1000,
          });
        }
      }
      return events;
    },
  };
}

function takeProfitRule(profitPct: number, ruleEnabled: boolean): RiskRule {
  return {
    name: "take_profit",
    enabled: ruleEnabled,
    evaluate(positions) {
      if (!ruleEnabled) return [];
      const events: RiskEvent[] = [];
      for (const position of positions) {
        if (position.entryPrice <= 0 || position.unrealizedPnl <= 0) continue;
        const profitPctVal =
          (position.unrealizedPnl / (position.entryPrice * Math.abs(position.size))) * 100;
        if (profitPctVal >= profitPct) {
          events.push({
            ruleName: "take_profit",
            asset: position.asset,
            action: RiskAction.CLOSE_POSITION,
            reason: `Take profit: ${profitPctVal.toFixed(2)}% >= ${profitPct}%`,
            severity: "MEDIUM",
            metadata: {
              positionSize: position.size,
              entryPrice: position.entryPrice,
              currentProfitPct: profitPctVal,
              thresholdPct: profitPct,
              unrealizedPnl: position.unrealizedPnl,
            },
            timestamp: Date.now() / 1000,
          });
        }
      }
      return events;
    },
  };
}

function drawdownRule(maxDrawdownPct: number): RiskRule {
  return {
    name: "max_drawdown",
    enabled: true,
    evaluate(_positions, _market, accountMetrics) {
      if (accountMetrics.drawdownPct < maxDrawdownPct) return [];
      return [
        {
          ruleName: "max_drawdown",
          asset: "ACCOUNT",
          action: RiskAction.EMERGENCY_EXIT,
          reason: `Max drawdown: ${accountMetrics.drawdownPct.toFixed(2)}% >= ${maxDrawdownPct}%`,
          severity: "CRITICAL",
          metadata: {
            currentDrawdownPct: accountMetrics.drawdownPct,
            maxDrawdownPct,
            totalPnl: accountMetrics.totalPnl,
            accountValue: accountMetrics.totalValue,
          },
          timestamp: Date.now() / 1000,
        },
      ];
    },
  };
}

function positionSizeRule(maxPositionSizePct: number): RiskRule {
  return {
    name: "max_position_size",
    enabled: true,
    evaluate(positions, _market, accountMetrics) {
      if (accountMetrics.totalValue <= 0) return [];
      const events: RiskEvent[] = [];
      for (const position of positions) {
        const positionPct = (position.currentValue / accountMetrics.totalValue) * 100;
        if (positionPct >= maxPositionSizePct) {
          events.push({
            ruleName: "max_position_size",
            asset: position.asset,
            action: RiskAction.REDUCE_POSITION,
            reason: `Position too large: ${positionPct.toFixed(2)}% >= ${maxPositionSizePct}%`,
            severity: "MEDIUM",
            metadata: {
              positionValue: position.currentValue,
              accountValue: accountMetrics.totalValue,
              positionPct,
              maxPositionPct: maxPositionSizePct,
            },
            timestamp: Date.now() / 1000,
          });
        }
      }
      return events;
    },
  };
}

export class RiskManager {
  private rules: RiskRule[] = [];
  private riskEventsHistory: RiskEvent[] = [];

  constructor(
    private readonly config: { risk_management?: RiskManagementYaml },
  ) {
    this.initRules();
  }

  private initRules(): void {
    const r = this.config.risk_management ?? {};
    if (r.stop_loss_enabled) {
      this.rules.push(
        stopLossRule(r.stop_loss_pct ?? 5, true),
      );
    }
    if (r.take_profit_enabled) {
      this.rules.push(
        takeProfitRule(r.take_profit_pct ?? 20, true),
      );
    }
    this.rules.push(
      drawdownRule(r.max_drawdown_pct ?? 15),
    );
    this.rules.push(
      positionSizeRule(r.max_position_size_pct ?? 30),
    );
  }

  evaluateRisks(
    positions: Position[],
    marketData: Record<string, MarketData>,
    accountMetrics: AccountMetrics,
  ): RiskEvent[] {
    const all: RiskEvent[] = [];
    for (const rule of this.rules) {
      try {
        if (!rule.enabled) continue;
        const events = rule.evaluate(positions, marketData, accountMetrics);
        all.push(...events);
        this.riskEventsHistory.push(...events);
      } catch (e) {
        all.push({
          ruleName: rule.name,
          asset: "SYSTEM",
          action: RiskAction.NONE,
          reason: `Rule evaluation failed: ${String(e)}`,
          severity: "LOW",
          metadata: { error: String(e) },
          timestamp: Date.now() / 1000,
        });
      }
    }
    return all;
  }

  getStatus(): Record<string, unknown> {
    return {
      enabledRules: this.rules.filter((r) => r.enabled).map((r) => r.name),
      totalRules: this.rules.length,
      recentEvents: this.riskEventsHistory.filter(
        (e) => Date.now() / 1000 - e.timestamp < 3600,
      ).length,
      config: this.config.risk_management ?? {},
    };
  }
}
