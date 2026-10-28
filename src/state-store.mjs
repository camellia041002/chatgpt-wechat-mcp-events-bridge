import path from "node:path";
import { atomicWriteJson, normalizeAccountId, readJson } from "./util.mjs";

const EMPTY_STATE = Object.freeze({
  version: 1,
  subscriptions: [],
  deliveries: [],
  inboundEvents: [],
  writeReceipts: [],
  processedMessages: {},
  contextTokens: {},
  syncBuffers: {},
  oauth: { clients: {}, authCodes: {}, accessTokens: {}, refreshTokens: {} },
});

export class StateStore {
  constructor({ stateDir }) {
    this.stateDir = path.resolve(stateDir);
    this.runtimeFile = path.join(this.stateDir, "transport-state.json");
    this.accountsDir = path.join(this.stateDir, "accounts");
    this.state = normalizeState(readJson(this.runtimeFile, EMPTY_STATE));
  }

  snapshot() {
    return structuredClone(this.state);
  }

  save() {
    trimState(this.state);
    atomicWriteJson(this.runtimeFile, this.state);
  }

  getAccount(accountId) {
    const normalized = normalizeAccountId(accountId);
    if (!normalized) return null;
    const account = readJson(path.join(this.accountsDir, `${normalized}.json`), null);
    if (!account?.accountId || !account?.token) return null;
    return {
      accountId: normalized,
      rawAccountId: String(account.rawAccountId ?? ""),
      token: String(account.token),
      baseUrl: String(account.baseUrl || "https://ilinkai.weixin.qq.com"),
      userId: String(account.userId ?? ""),
      savedAt: String(account.savedAt ?? ""),
    };
  }

  saveAccount(rawAccountId, account) {
    const accountId = normalizeAccountId(rawAccountId);
    if (!accountId || !String(account?.token ?? "").trim()) {
      throw new Error("A valid account ID and bot token are required");
    }
    const value = {
      accountId,
      rawAccountId: String(rawAccountId).trim(),
      token: String(account.token).trim(),
      baseUrl: String(account.baseUrl || "https://ilinkai.weixin.qq.com").trim(),
      userId: String(account.userId ?? "").trim(),
      savedAt: new Date().toISOString(),
    };
    atomicWriteJson(path.join(this.accountsDir, `${accountId}.json`), value);
    return { ...value, token: "<redacted>" };
  }

  getContextToken(accountId, userId) {
    return String(this.state.contextTokens?.[normalizeAccountId(accountId)]?.[String(userId).trim()] ?? "");
  }

  rememberContextToken(accountId, userId, token) {
    const account = normalizeAccountId(accountId);
    const user = String(userId ?? "").trim();
    const value = String(token ?? "").trim();
    if (!account || !user || !value) return false;
    this.state.contextTokens[account] ||= {};
    if (this.state.contextTokens[account][user] === value) return false;
    this.state.contextTokens[account][user] = value;
    this.save();
    return true;
  }

  getSyncBuffer(accountId) {
    return String(this.state.syncBuffers?.[normalizeAccountId(accountId)] ?? "");
  }

  setSyncBuffer(accountId, value) {
    const account = normalizeAccountId(accountId);
    if (!account) return;
    this.state.syncBuffers[account] = String(value ?? "");
    this.save();
  }
}

function normalizeState(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    version: 1,
    subscriptions: Array.isArray(source.subscriptions) ? source.subscriptions : [],
    deliveries: Array.isArray(source.deliveries) ? source.deliveries : [],
    inboundEvents: Array.isArray(source.inboundEvents) ? source.inboundEvents : [],
    writeReceipts: Array.isArray(source.writeReceipts) ? source.writeReceipts : [],
    processedMessages: source.processedMessages && typeof source.processedMessages === "object" ? source.processedMessages : {},
    contextTokens: source.contextTokens && typeof source.contextTokens === "object" ? source.contextTokens : {},
    syncBuffers: source.syncBuffers && typeof source.syncBuffers === "object" ? source.syncBuffers : {},
    oauth: {
      clients: source.oauth?.clients && typeof source.oauth.clients === "object" ? source.oauth.clients : {},
      authCodes: source.oauth?.authCodes && typeof source.oauth.authCodes === "object" ? source.oauth.authCodes : {},
      accessTokens: source.oauth?.accessTokens && typeof source.oauth.accessTokens === "object" ? source.oauth.accessTokens : {},
      refreshTokens: source.oauth?.refreshTokens && typeof source.oauth.refreshTokens === "object" ? source.oauth.refreshTokens : {},
    },
  };
}

function trimState(state) {
  state.deliveries = state.deliveries.slice(-500);
  state.inboundEvents = state.inboundEvents.slice(-500);
  state.writeReceipts = state.writeReceipts.slice(-500);
  const processed = Object.entries(state.processedMessages);
  if (processed.length > 2000) state.processedMessages = Object.fromEntries(processed.slice(-2000));
  const now = Date.now();
  state.oauth.authCodes = Object.fromEntries(Object.entries(state.oauth.authCodes).filter(([, record]) => Number(record.expiresAt) > now));
  state.oauth.accessTokens = Object.fromEntries(Object.entries(state.oauth.accessTokens).filter(([, record]) => Number(record.expiresAt) > now));
}

