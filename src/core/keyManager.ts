import fs from "node:fs";
import path from "node:path";
import type { Logger } from "pino";

function readKeyFile(filePath: string, logger: Logger | undefined): string | undefined {
  try {
    const p = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
    if (!fs.existsSync(p)) {
      logger?.warn({ file: filePath }, "Private key file not found");
      return undefined;
    }
    let k = fs.readFileSync(p, "utf8").trim();
    if (!k.startsWith("0x")) k = `0x${k}`;
    if (k.length !== 66) {
      logger?.warn({ file: filePath }, "Invalid private key length in file");
      return undefined;
    }
    return k;
  } catch (e) {
    logger?.error({ err: e, file: filePath }, "Failed to read private key file");
    return undefined;
  }
}

export class KeyManager {
  constructor(private readonly logger?: Logger) {}

  getPrivateKey(
    testnet: boolean,
    botConfig: Record<string, string | undefined> | undefined,
  ): string {
    const network = testnet ? "testnet" : "mainnet";

    if (botConfig) {
      const bot = this.getBotSpecificKey(botConfig, testnet);
      if (bot) {
        this.logger?.debug(`Using bot-specific private key for ${network}`);
        return bot;
      }
    }

    const envKey = this.getEnvSpecificKey(testnet);
    if (envKey) {
      this.logger?.debug(`Using environment-specific private key for ${network}`);
      return envKey;
    }

    const legacy = process.env.HYPERLIQUID_PRIVATE_KEY;
    if (legacy) {
      this.logger?.warn(
        `Using legacy HYPERLIQUID_PRIVATE_KEY for ${network} — prefer HYPERLIQUID_TESTNET_PRIVATE_KEY / HYPERLIQUID_MAINNET_PRIVATE_KEY`,
      );
      return legacy.startsWith("0x") ? legacy : `0x${legacy}`;
    }

    const fileKey = this.getFileKey(testnet);
    if (fileKey) {
      this.logger?.debug(`Using file-based private key for ${network}`);
      return fileKey;
    }

    const legacyFile = process.env.HYPERLIQUID_PRIVATE_KEY_FILE;
    if (legacyFile) {
      const k = readKeyFile(legacyFile, this.logger);
      if (k) {
        this.logger?.warn("Using legacy HYPERLIQUID_PRIVATE_KEY_FILE");
        return k;
      }
    }

    throw new Error(
      `No private key found for ${network}. Set one of: HYPERLIQUID_${testnet ? "TESTNET" : "MAINNET"}_PRIVATE_KEY, HYPERLIQUID_PRIVATE_KEY, or a key file env.`,
    );
  }

  private getBotSpecificKey(
    botConfig: Record<string, string | undefined>,
    testnet: boolean,
  ): string | undefined {
    if (testnet && botConfig.testnet_private_key) return this.normalizeKey(botConfig.testnet_private_key);
    if (!testnet && botConfig.mainnet_private_key)
      return this.normalizeKey(botConfig.mainnet_private_key);
    if (botConfig.private_key) return this.normalizeKey(botConfig.private_key);

    const keyFile = testnet ? botConfig.testnet_key_file : botConfig.mainnet_key_file;
    if (keyFile) {
      return readKeyFile(keyFile, this.logger);
    }
    if (botConfig.private_key_file) {
      return readKeyFile(botConfig.private_key_file, this.logger);
    }
    return undefined;
  }

  private normalizeKey(k: string): string {
    return k.startsWith("0x") ? k : `0x${k}`;
  }

  private getEnvSpecificKey(testnet: boolean): string | undefined {
    const v = testnet
      ? process.env.HYPERLIQUID_TESTNET_PRIVATE_KEY
      : process.env.HYPERLIQUID_MAINNET_PRIVATE_KEY;
    return v ? this.normalizeKey(v) : undefined;
  }

  private getFileKey(testnet: boolean): string | undefined {
    const f = testnet
      ? process.env.HYPERLIQUID_TESTNET_KEY_FILE
      : process.env.HYPERLIQUID_MAINNET_KEY_FILE;
    return f ? readKeyFile(f, this.logger) : undefined;
  }
}

export const keyManager = new KeyManager();
