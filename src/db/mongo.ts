// src/db/mongo.ts
import mongoose from "mongoose";
import config from "../config";
import logger from "../logger/logger";

/**
 * Centralized Mongo connection helpers.
 * - Exports both `connect` and `connectToMongo` for compatibility.
 * - Exports both `close` and `closeMongo`.
 * - Also provides a default export object.
 */

async function _connectImpl() {
  const uri = (config as any).mongoUri || (config as any).mongo?.uri;
  if (!uri) {
    const err = new Error("Missing mongo URI in config (config.mongoUri or config.mongo.uri)");
    logger.error("Mongo: missing URI", err);
    throw err;
  }
  // If auth is needed, you can pass user/pass in options here.
  await mongoose.connect(uri, {
    // keep defaults; you can add options here if required
  } as mongoose.ConnectOptions);
  logger.info("MongoDB connected");
}

export async function connect() {
  try {
    await _connectImpl();
  } catch (err) {
    logger.error("mongo.connect failed", err);
    throw err;
  }
}

export async function connectToMongo() {
  return connect();
}

export async function close() {
  try {
    await mongoose.disconnect();
    logger.info("MongoDB disconnected");
  } catch (err) {
    logger.warn("mongo.close failed", err);
    throw err;
  }
}

export async function closeMongo() {
  return close();
}

export default {
  connect,
  connectToMongo,
  close,
  closeMongo,
};
