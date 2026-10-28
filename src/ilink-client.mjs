import crypto from "node:crypto";
import { redactSensitiveText } from "./util.mjs";

const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
const API_TIMEOUT_MS = 15_000;
const LONG_POLL_TIMEOUT_MS = 35_000;
const MAX_RESPONSE_BYTES = 64 << 20;

export class ILinkClient {
  constructor({ fetchFn = fetch, channelVersion = "0.1.0", appId = "bot" } = {}) {
    this.fetchFn = fetchFn;
    this.channelVersion = channelVersion;
    this.appId = appId;
    this.appClientVersion = encodeClientVersion(channelVersion);
  }

  async fetchQrCode(baseUrl = DEFAULT_BASE_URL, botType = "3", localTokenList = []) {
    const url = new URL(`ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`, trailingSlash(baseUrl));
    const body = JSON.stringify({ local_token_list: localTokenList.slice(-10) });
    return this.#requestJson(url, {
      method: "POST",
      headers: this.#postHeaders(),
      body,
    }, "getBotQrCode", 15_000);
  }

  async pollQrStatus(baseUrl, qrcode, verifyCode = "") {
    const suffix = verifyCode ? `&verify_code=${encodeURIComponent(verifyCode)}` : "";
    const url = new URL(`ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}${suffix}`, trailingSlash(baseUrl));
    return this.#requestJson(url, { method: "GET", headers: this.#commonHeaders() }, "getQrCodeStatus", LONG_POLL_TIMEOUT_MS);
  }

  async getUpdates({ baseUrl = DEFAULT_BASE_URL, token, getUpdatesBuf = "", timeoutMs = LONG_POLL_TIMEOUT_MS }) {
    return this.#post(baseUrl, "ilink/bot/getupdates", token, {
      get_updates_buf: getUpdatesBuf,
      base_info: this.#baseInfo(),
    }, "getUpdates", timeoutMs);
  }

  async notifyStart({ baseUrl = DEFAULT_BASE_URL, token }) {
    return this.#post(baseUrl, "ilink/bot/msg/notifystart", token, {
      base_info: this.#baseInfo(),
    }, "notifyStart", API_TIMEOUT_MS);
  }

  async notifyStop({ baseUrl = DEFAULT_BASE_URL, token }) {
    return this.#post(baseUrl, "ilink/bot/msg/notifystop", token, {
      base_info: this.#baseInfo(),
    }, "notifyStop", API_TIMEOUT_MS);
  }

  async sendText({ baseUrl = DEFAULT_BASE_URL, token, toUserId, text, contextToken, clientId, runId }) {
    const normalizedText = String(text ?? "").trim();
    if (!normalizedText) throw new Error("sendText requires non-empty text");
    if (!String(contextToken ?? "").trim()) throw new Error("sendText requires context_token");
    return this.#post(baseUrl, "ilink/bot/sendmessage", token, {
      msg: {
        from_user_id: "",
        to_user_id: String(toUserId).trim(),
        client_id: String(clientId || `wwit-${crypto.randomUUID()}`),
        message_type: 2,
        message_state: 2,
        item_list: [{ type: 1, text_item: { text: normalizedText } }],
        context_token: String(contextToken).trim(),
        run_id: String(runId || "").trim(),
      },
      base_info: this.#baseInfo(),
    }, "sendMessage", API_TIMEOUT_MS);
  }

  #baseInfo() {
    return { channel_version: this.channelVersion };
  }

  async #post(baseUrl, endpoint, token, value, label, timeoutMs) {
    const body = JSON.stringify(value);
    const headers = {
      ...this.#postHeaders(),
    };
    if (String(token ?? "").trim()) headers.Authorization = `Bearer ${String(token).trim()}`;
    return this.#requestJson(new URL(endpoint, trailingSlash(baseUrl)), { method: "POST", headers, body }, label, timeoutMs);
  }

  #commonHeaders() {
    return {
      "iLink-App-Id": this.appId,
      "iLink-App-ClientVersion": this.appClientVersion,
    };
  }

  #postHeaders() {
    return {
      "Content-Type": "application/json",
      AuthorizationType: "ilink_bot_token",
      "X-WECHAT-UIN": Buffer.from(String(crypto.randomBytes(4).readUInt32BE(0))).toString("base64"),
      ...this.#commonHeaders(),
    };
  }

  async #requestJson(url, options, label, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs + 5_000);
    try {
      const response = await this.fetchFn(url, { ...options, signal: controller.signal, redirect: "error" });
      const raw = await response.text();
      if (Buffer.byteLength(raw) > MAX_RESPONSE_BYTES) throw new Error(`${label} response too large`);
      if (!response.ok) throw new Error(`${label} HTTP ${response.status}: ${redactSensitiveText(raw, 512)}`);
      let parsed;
      try { parsed = JSON.parse(raw); } catch { throw new Error(`${label} returned invalid JSON`); }
      const ret = parsed?.ret;
      const errcode = parsed?.errcode;
      if ((ret !== undefined && ret !== 0) || (errcode !== undefined && errcode !== 0)) {
        throw new Error(`${label} ret=${ret ?? ""} errcode=${errcode ?? ""} errmsg=${redactSensitiveText(parsed?.errmsg ?? "")}`);
      }
      return parsed;
    } finally {
      clearTimeout(timer);
    }
  }
}

function trailingSlash(value) {
  const text = String(value || DEFAULT_BASE_URL);
  return text.endsWith("/") ? text : `${text}/`;
}

function encodeClientVersion(value) {
  const [major = 0, minor = 0, patch = 0] = String(value || "0.1.0").split(".").map((item) => Number.parseInt(item, 10) || 0);
  return String(((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff));
}
