import { config as loadEnv } from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { TradingEngine } from "./core/engine.js";
import { EnhancedConfigLoader } from "./core/enhancedConfig.js";
import { keyManager } from "./core/keyManager.js";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, "..");
loadEnv({ path: path.join(projectRoot, ".env") });
loadEnv({ path: path.join(process.cwd(), ".env") });

const BASE = 10_000;

type EngineConfigFromYaml = ReturnType<typeof convertConfig>;

function ensureWalletConfigured(engineConfig: EngineConfigFromYaml): boolean {
  try {
    keyManager.getPrivateKey(engineConfig.exchange.testnet, engineConfig.bot_config);
    return true;
  } catch {
    const testnet = engineConfig.exchange.testnet;
    const net = testnet ? "testnet" : "mainnet";
    const envVar = testnet ? "HYPERLIQUID_TESTNET_PRIVATE_KEY" : "HYPERLIQUID_MAINNET_PRIVATE_KEY";
    const keyFile = testnet
      ? engineConfig.bot_config.testnet_key_file ?? engineConfig.bot_config.private_key_file
      : engineConfig.bot_config.mainnet_key_file ?? engineConfig.bot_config.private_key_file;

    console.error(`No Hyperliquid private key found for ${net}.`);
    console.error("");
    console.error("Configure one of:");
    console.error(`  • Create ${path.join(projectRoot, ".env")} from .env.example and set ${envVar}=0x…`);
    if (keyFile) {
      console.error(
        `  • Or write your key (64 hex chars, optional 0x prefix) to: ${path.resolve(process.cwd(), keyFile)}`,
      );
    } else {
      console.error(
        `  • Or set ${envVar}, or add testnet_key_file / mainnet_key_file to your bots/*.yaml`,
      );
    }
    console.error("");
    return false;
  }
}

function convertConfig(configPath: string) {
  const c = EnhancedConfigLoader.fromYaml(configPath);
  const testnet =
    process.env.HYPERLIQUID_TESTNET === undefined
      ? c.exchange.testnet
      : process.env.HYPERLIQUID_TESTNET === "true";

  const baseAllocation = BASE;
  const totalAllocationUsd = baseAllocation * (c.account.max_allocation_pct / 100);

  return {
    exchange: {
      type: c.exchange.type,
      testnet,
    },
    strategy: {
      type: "basic_grid" as const,
      symbol: c.grid.symbol,
      levels: c.grid.levels,
      range_pct: c.grid.price_range.auto.range_pct,
      total_allocation: totalAllocationUsd,
      rebalance_threshold_pct: c.risk_management.rebalance.price_move_threshold_pct,
    },
    bot_config: {
      name: c.name,
      private_key: c.private_key,
      testnet_key_file: c.testnet_key_file,
      mainnet_key_file: c.mainnet_key_file,
      private_key_file: c.private_key_file,
      testnet_private_key: c.testnet_private_key,
      mainnet_private_key: c.mainnet_private_key,
    },
    log_level: c.monitoring.log_level,
    risk_management: c.risk_management,
  };
}

function findFirstActiveConfig(): string | null {
  const root = process.cwd();
  const botsDir = path.join(root, "bots");
  if (!fs.existsSync(botsDir)) return null;
  const files = fs
    .readdirSync(botsDir)
    .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
    .sort();
  for (const f of files) {
    try {
      const data = yaml.load(fs.readFileSync(path.join(botsDir, f), "utf8")) as {
        active?: boolean;
      };
      if (data && data.active === true) {
        console.log(`Found active config: ${f}`);
        return path.join(botsDir, f);
      }
    } catch {
      continue;
    }
  }
  return null;
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const validateOnly = args.includes("--validate");
  const pos = args.filter((a) => !a.startsWith("-"));
  const configPath = pos[0] ? path.resolve(pos[0]) : findFirstActiveConfig();
  if (!configPath) {
    console.error("No config: pass a YAML file or set active: true in bots/*.yaml");
    return 1;
  }
  if (!fs.existsSync(configPath)) {
    console.error(`Config not found: ${configPath}`);
    return 1;
  }

  if (validateOnly) {
    try {
      const c = EnhancedConfigLoader.fromYaml(configPath);
      EnhancedConfigLoader.validate(c);
      console.log("Configuration is valid");
      return 0;
    } catch (e) {
      console.error("Configuration error:", e);
      return 1;
    }
  }

  const engineConfig = convertConfig(configPath);
  if (!ensureWalletConfigured(engineConfig)) return 1;

  const engine = new TradingEngine(engineConfig);
  if (!(await engine.initialize())) {
    console.error("Failed to initialize engine");
    return 1;
  }

  const onStop = () => {
    void engine.stop().then(() => process.exit(0));
  };
  process.on("SIGINT", onStop);
  process.on("SIGTERM", onStop);

  await engine.start();
  return 0;
}

main()
  .then((code) => {
    if (code !== 0) process.exit(code);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
