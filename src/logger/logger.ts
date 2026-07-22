/**
 * Simple logger wrapper
 *
 * - Minimal dependency logger (no winston) so setup stays light.
 * - Adds timestamps and level prefixes.
 * - In development NODE_ENV !== 'production' we enable debug logs.
 *
 * Usage:
 *   import logger from "../logger/logger";
 *   logger.info("server started", { port });
 *   const child = logger.child({ component: "wsService" });
 *   child.error("failed to send", err);
 */

type Meta = Record<string, unknown>;

const isDev = process.env.NODE_ENV !== "production";

function ts() {
  return new Date().toISOString();
}

function formatArgs(args: any[]) {
  return args.map((a) => {
    if (a instanceof Error) {
      return { message: a.message, stack: a.stack };
    }
    try {
      // keep primitives as-is; stringify objects for clarity
      if (typeof a === "object" && a !== null) return JSON.stringify(a);
      return a;
    } catch {
      return String(a);
    }
  });
}

export interface Logger {
  debug: (...args: any[]) => void;
  info: (...args: any[]) => void;
  warn: (...args: any[]) => void;
  error: (...args: any[]) => void;
  child: (meta: Meta) => Logger;
}

const baseLogger: Logger = {
  debug: (...args: any[]) => {
    if (!isDev) return;
    const out = formatArgs(args);
    console.debug(`[DEBUG] ${ts()} -`, ...out);
  },

  info: (...args: any[]) => {
    const out = formatArgs(args);
    console.log(`[INFO ] ${ts()} -`, ...out);
  },

  warn: (...args: any[]) => {
    const out = formatArgs(args);
    console.warn(`[WARN ] ${ts()} -`, ...out);
  },

  error: (...args: any[]) => {
    const out = formatArgs(args);
    console.error(`[ERROR] ${ts()} -`, ...out);
  },

  child: (meta: Meta) => {
    const metaStr = JSON.stringify(meta);
    const make = (levelFn: (...args: any[]) => void) => (...args: any[]) => {
      const out = formatArgs(args);
      levelFn(`[${metaStr}]`, ...out);
    };

    return {
      debug: (...args: any[]) => {
        if (!isDev) return;
        make(baseLogger.debug)(...args);
      },
      info: (...args: any[]) => make(baseLogger.info)(...args),
      warn: (...args: any[]) => make(baseLogger.warn)(...args),
      error: (...args: any[]) => make(baseLogger.error)(...args),
      child: (childMeta: Meta) =>
        baseLogger.child({ ...meta, ...childMeta }),
    } as Logger;
  },
};

export default baseLogger;
