import { canonicalJson, normalizeAccountId, requireText, sha256, sleep } from "./util.mjs";

const EVENT_NAME = "wechat.message.received";
const MAX_REPLY_CHARS = 24_000;
const MAX_WEIXIN_CHUNK = 3_800;
const WEIXIN_MAX_DELIVERY_MESSAGES = 9;
const DEFAULT_CHUNK_DELAY_MS = 900;

export class WeChatTransport {
  constructor({
    store,
    ilinkClient,
    accountId = "",
    channelId = "second-wechat",
    mode = "simulation",
    now = () => new Date(),
    onEvent = async () => {},
    chunkDelayMs = DEFAULT_CHUNK_DELAY_MS,
    random = Math.random,
    pollingEnabled = false,
  }) {
    this.store = store;
    this.ilinkClient = ilinkClient;
    this.accountId = normalizeAccountId(accountId);
    this.channelId = requireText(channelId, "channelId", 120);
    this.mode = mode === "real" ? "real" : "simulation";
    this.now = now;
    this.onEvent = onEvent;
    this.chunkDelayMs = chunkDelayMs;
    this.random = random;
    this.pollingEnabled = Boolean(pollingEnabled);
    this.inFlightWrites = new Map();
  }

  status() {
    const state = this.store.state;
    return {
      mode: this.mode,
      pollingEnabled: this.pollingEnabled,
      realWeChatConnected: this.mode === "real" && Boolean(this.accountId && this.store.getAccount(this.accountId)),
      accountConfigured: Boolean(this.accountId && this.store.getAccount(this.accountId)),
      channelId: this.channelId,
      eventName: EVENT_NAME,
      subscriptions: state.subscriptions.length,
      inboundEventCount: state.inboundEvents.length,
      pendingMessageCount: this.pendingMessages({ limit: 10_000 }).count,
      successfulWriteCount: state.writeReceipts.filter((item) => item.status === "succeeded").length,
      latestInboundEvent: redactInbound(state.inboundEvents.at(-1)),
      latestWrite: redactReceipt(state.writeReceipts.at(-1)),
    };
  }

  setEventHandler(handler) {
    if (typeof handler !== "function") throw new Error("event handler must be a function");
    this.onEvent = handler;
  }

  async start() {
    if (this.mode !== "real" || !this.pollingEnabled) return { skipped: true };
    const account = this.#selectedAccount();
    return this.ilinkClient.notifyStart({ baseUrl: account.baseUrl, token: account.token });
  }

  async stop() {
    if (this.mode !== "real" || !this.pollingEnabled) return { skipped: true };
    const account = this.#selectedAccount();
    return this.ilinkClient.notifyStop({ baseUrl: account.baseUrl, token: account.token });
  }

  async pollOnce({ timeoutMs } = {}) {
    if (this.mode !== "real") throw new Error("Real iLink polling is disabled in simulation mode");
    const account = this.#selectedAccount();
    const syncBuffer = this.store.getSyncBuffer(account.accountId);
    const response = await this.ilinkClient.getUpdates({
      baseUrl: account.baseUrl,
      token: account.token,
      getUpdatesBuf: syncBuffer,
      ...(timeoutMs ? { timeoutMs } : {}),
    });
    const messages = Array.isArray(response?.msgs) ? response.msgs : [];
    const events = [];
    for (const message of messages) {
      const event = await this.acceptRawMessage(message, { accountId: account.accountId });
      if (event) events.push(event);
    }
    const nextBuffer = String(response?.get_updates_buf ?? "").trim();
    if (nextBuffer && nextBuffer !== syncBuffer) this.store.setSyncBuffer(account.accountId, nextBuffer);
    return { messageCount: messages.length, acceptedCount: events.length, events };
  }

  async acceptRawMessage(message, { accountId = this.accountId } = {}) {
    const normalized = normalizeInboundMessage(message, {
      accountId,
      channelId: this.channelId,
      now: this.now,
    });
    if (!normalized) return null;

    const existingId = this.store.state.processedMessages[normalized.dedupKey];
    if (existingId) return null;

    if (normalized.contextToken) {
      this.store.rememberContextToken(normalized.accountId, normalized.senderId, normalized.contextToken);
    }

    const event = {
      eventId: normalized.eventId,
      name: EVENT_NAME,
      timestamp: normalized.receivedAt,
      data: {
        channel_id: this.channelId,
        sender_id: normalized.senderId,
        conversation_id: normalized.conversationId,
        message_id: normalized.messageId,
        text: normalized.text,
        received_at: normalized.receivedAt,
      },
      cursor: null,
      internal: {
        accountId: normalized.accountId,
        senderId: normalized.senderId,
        dedupKey: normalized.dedupKey,
      },
    };
    this.store.state.inboundEvents.push(event);
    this.store.state.processedMessages[normalized.dedupKey] = event.eventId;
    this.store.save();
    await this.onEvent(publicEvent(event));
    return publicEvent(event);
  }

  async injectTestMessage({ senderId = "test-user", text = "Test WeChat message", messageId = "" } = {}) {
    if (this.mode !== "simulation") throw new Error("Test injection is available only in simulation mode");
    const stableMessageId = messageId || `test-${this.now().getTime()}`;
    return this.acceptRawMessage({
      from_user_id: senderId,
      message_id: stableMessageId,
      client_id: stableMessageId,
      message_type: 1,
      create_time_ms: this.now().getTime(),
      context_token: `simulation-context-${sha256(senderId).slice(0, 12)}`,
      item_list: [{ type: 1, text_item: { text } }],
    }, { accountId: this.accountId || "simulation-account" });
  }

  pendingMessages({ limit = 5 } = {}) {
    const boundedLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 5, 1), 10);
    const succeededEventIds = new Set(
      this.store.state.writeReceipts
        .filter((item) => item.status === "succeeded")
        .map((item) => item.eventId),
    );
    const pending = this.store.state.inboundEvents.filter((event) => !succeededEventIds.has(event.eventId));
    return {
      channelId: this.channelId,
      count: pending.length,
      truncated: pending.length > boundedLimit,
      messages: pending.slice(0, boundedLimit).map((event) => ({
        eventId: event.eventId,
        senderId: event.data.sender_id,
        conversationId: event.data.conversation_id,
        text: event.data.text,
        receivedAt: event.data.received_at,
      })),
    };
  }

  async sendReply({ eventId, toUserId, text, idempotencyKey }) {
    const normalizedEventId = requireText(eventId, "event_id", 200);
    const normalizedUserId = requireText(toUserId, "to_user_id", 256);
    const normalizedText = requireText(text, "text", MAX_REPLY_CHARS);
    const normalizedKey = requireText(idempotencyKey, "idempotency_key", 240);
    const event = this.store.state.inboundEvents.find((item) => item.eventId === normalizedEventId);
    if (!event) throw new Error("event_id is not a known inbound WeChat event");
    if (event.internal?.senderId !== normalizedUserId) {
      throw new Error("to_user_id must match the sender bound to event_id");
    }
    const existing = this.store.state.writeReceipts.find((item) => item.idempotencyKey === normalizedKey);
    if (existing?.status === "succeeded") {
      return { duplicate: true, ...redactReceipt(existing), externalSideEffects: this.mode === "real" ? existing.chunkCount : 0 };
    }
    if (existing && existing.eventId !== normalizedEventId) {
      throw new Error("idempotency_key is already bound to another event");
    }

    const inFlight = this.inFlightWrites.get(normalizedKey);
    if (inFlight) {
      const result = await inFlight;
      return { ...result, duplicate: true, externalSideEffects: 0 };
    }

    const execution = this.#executeReply({
      event,
      existing,
      normalizedEventId,
      normalizedUserId,
      normalizedText,
      normalizedKey,
    });
    this.inFlightWrites.set(normalizedKey, execution);
    try {
      return await execution;
    } finally {
      if (this.inFlightWrites.get(normalizedKey) === execution) this.inFlightWrites.delete(normalizedKey);
    }
  }

  async #executeReply({ event, existing, normalizedEventId, normalizedUserId, normalizedText, normalizedKey }) {
    const chunks = prepareWeixinDeliveryChunks(normalizedText);
    const clientIds = chunks.map((_, index) => `wwit-${sha256(`${normalizedKey}:${index}`).slice(0, 32)}`);
    const runId = `wwit-run-${sha256(normalizedKey).slice(0, 32)}`;
    const receipt = existing || {
      eventId: normalizedEventId,
      idempotencyKey: normalizedKey,
      toUserId: normalizedUserId,
      accountId: event.internal.accountId,
      textSha256: sha256(normalizedText),
      clientIds,
      runId,
      chunkCount: chunks.length,
      status: "pending",
      attempts: 0,
      createdAt: this.now().toISOString(),
    };
    receipt.clientIds = clientIds;
    receipt.runId = runId;
    receipt.chunkCount = chunks.length;
    if (!existing) this.store.state.writeReceipts.push(receipt);
    receipt.status = "pending";
    receipt.attempts += 1;
    receipt.lastAttemptAt = this.now().toISOString();
    this.store.save();

    try {
      if (this.mode === "real") {
        const account = this.#selectedAccount(event.internal.accountId);
        const contextToken = this.store.getContextToken(account.accountId, normalizedUserId);
        if (!contextToken) throw new Error("No context_token is available for this event sender");
        for (let index = 0; index < chunks.length; index += 1) {
          const deliveryText = finalizeWeixinDeliveryChunk(chunks[index]) || "Completed.";
          await this.ilinkClient.sendText({
            baseUrl: account.baseUrl,
            token: account.token,
            toUserId: normalizedUserId,
            text: deliveryText,
            contextToken,
            clientId: receipt.clientIds[index],
            runId: receipt.runId,
          });
          if (index < chunks.length - 1 && this.chunkDelayMs > 0) {
            await sleep(resolveWeixinChunkDelayMs(deliveryText, this.chunkDelayMs, this.random));
          }
        }
      }
      receipt.status = "succeeded";
      receipt.completedAt = this.now().toISOString();
      receipt.errorCode = "";
      this.store.save();
      return {
        duplicate: false,
        ...redactReceipt(receipt),
        dryRun: this.mode !== "real",
        realWeChatConnected: this.mode === "real",
        externalSideEffects: this.mode === "real" ? chunks.length : 0,
      };
    } catch (error) {
      receipt.status = "failed";
      receipt.failedAt = this.now().toISOString();
      receipt.errorCode = classifySendError(error);
      this.store.save();
      throw error;
    }
  }

  #selectedAccount(expectedAccountId = this.accountId) {
    const accountId = normalizeAccountId(expectedAccountId || this.accountId);
    if (!accountId) throw new Error("TRANSPORT_ACCOUNT_ID is required for real mode");
    if (this.accountId && accountId !== this.accountId) throw new Error("Event account does not match the configured transport account");
    const account = this.store.getAccount(accountId);
    if (!account) throw new Error("The configured iLink account is not logged in");
    return account;
  }
}

export function normalizeInboundMessage(message, { accountId, channelId, now = () => new Date() }) {
  if (!message || typeof message !== "object") return null;
  const messageType = Number(message.message_type);
  if (messageType === 2 || (messageType !== 0 && messageType !== 1)) return null;
  const senderId = String(message.from_user_id ?? "").trim();
  if (!senderId) return null;
  const text = inboundText(message.item_list);
  if (!text) return null;
  const createdAtMs = positiveNumber(message.create_time_ms) || positiveNumber(message.create_time) * 1000 || now().getTime();
  const messageId = String(message.message_id ?? message.client_id ?? "").trim();
  const conversationId = String(message.session_id ?? senderId).trim();
  const dedupIdentity = {
    accountId: normalizeAccountId(accountId),
    senderId,
    messageId,
    seq: Number(message.seq) || 0,
    clientId: String(message.client_id ?? "").trim(),
    createdAtMs,
    textHash: sha256(text),
  };
  const dedupKey = sha256(canonicalJson(dedupIdentity));
  return {
    accountId: normalizeAccountId(accountId),
    channelId,
    senderId,
    conversationId,
    messageId,
    text,
    contextToken: String(message.context_token ?? "").trim(),
    receivedAt: new Date(createdAtMs).toISOString(),
    dedupKey,
    eventId: `evt_wechat_${dedupKey.slice(0, 32)}`,
  };
}

function inboundText(itemList) {
  if (!Array.isArray(itemList)) return "";
  for (const item of itemList) {
    if (Number(item?.type) === 1) {
      const text = String(item?.text_item?.text ?? "").trim();
      if (text) return text;
    }
    if (Number(item?.type) === 3) {
      const text = String(item?.voice_item?.text ?? "").trim();
      if (text) return text;
    }
  }
  return "";
}

function normalizeLineEndings(text) {
  return String(text || "").replace(/\r\n/g, "\n");
}

function trimOuterBlankLines(text) {
  return String(text || "")
    .replace(/^\s*\n+/g, "")
    .replace(/\n+\s*$/g, "");
}

function normalizeWeixinReplyText(text) {
  return trimOuterBlankLines(normalizeLineEndings(text));
}

function stripChunkTailChineseFullStops(text) {
  return String(text || "").replace(/(^|[^。])。(?=(?:\s*["'”’）)\]\u300d\u300f\u3011》])*\s*$)/u, "$1");
}

function finalizeWeixinDeliveryChunk(text) {
  const normalized = normalizeLineEndings(text);
  if (!normalized.trim()) return "";
  return trimOuterBlankLines(stripChunkTailChineseFullStops(normalized));
}

function splitAtBlankLineBoundaries(text) {
  return normalizeLineEndings(text)
    .split(/\n[\t ]*\n+/)
    .map((block) => trimOuterBlankLines(block))
    .filter((block) => block.trim());
}

function splitTextAtBoundaries(text, boundaries) {
  const units = [];
  let start = 0;
  for (const boundary of boundaries) {
    if (boundary <= start) continue;
    const unit = text.slice(start, boundary);
    if (unit.trim()) units.push(unit);
    start = boundary;
  }
  const tail = text.slice(start);
  if (tail.trim()) units.push(tail);
  return units;
}

function isClosingDelimiterAt(text, index) {
  const char = text[index];
  if (/[”’）)\]\u300d\u300f\u3011》]/u.test(char || "")) return true;
  if (char !== '"' && char !== "'") return false;
  const next = text[index + 1] || "";
  return !next || /[\s,，。！？!?;；:：…）)\]\u300d\u300f\u3011》]/u.test(next);
}

function consumeRepeatedChar(text, index, char) {
  let end = index + 1;
  while (end < text.length && text[end] === char) end += 1;
  return end;
}

function findBoundaryPunctuationEnd(text, index) {
  const char = text[index];
  if (/[\u3002\uff01\uff1f!?]/u.test(char)) return consumeRepeatedChar(text, index, char);
  if (char === ".") {
    const end = consumeRepeatedChar(text, index, ".");
    return end - index >= 3 ? end : 0;
  }
  if (char === "…") return consumeRepeatedChar(text, index, "…");
  return 0;
}

function collectStreamingBoundaries(text) {
  const boundaries = new Set();
  const blankLineRegex = /\n\s*\n+/g;
  let match = blankLineRegex.exec(text);
  while (match) {
    boundaries.add(match.index + match[0].length);
    match = blankLineRegex.exec(text);
  }

  const listRegex = /\n(?:(?:[-*])\s+|(?:\d+\.)\s+)/g;
  match = listRegex.exec(text);
  while (match) {
    boundaries.add(match.index + 1);
    match = listRegex.exec(text);
  }

  for (let index = 0; index < text.length; index += 1) {
    const punctuationEnd = findBoundaryPunctuationEnd(text, index);
    if (!punctuationEnd) continue;
    let end = punctuationEnd;
    while (end < text.length && isClosingDelimiterAt(text, end)) end += 1;
    while (end < text.length && /[\t \n]/.test(text[end])) end += 1;
    boundaries.add(end);
    index = punctuationEnd - 1;
  }
  return Array.from(boundaries).sort((left, right) => left - right);
}

function findLastPreferredBoundary(text, maxBoundary = text.length, minBoundary = 0) {
  const boundaries = collectStreamingBoundaries(text);
  for (let index = boundaries.length - 1; index >= 0; index -= 1) {
    const boundary = boundaries[index];
    if (boundary > maxBoundary) continue;
    if (boundary > minBoundary) return boundary;
    break;
  }
  return 0;
}

function adjustHardCutBoundary(text, limit) {
  let cut = Math.min(limit, text.length);
  const previous = text[cut - 1] || "";
  if (/[“‘「『《（([{]/u.test(previous)
      || ((previous === '"' || previous === "'") && !isClosingDelimiterAt(text, cut - 1))) {
    cut -= 1;
  }
  return Math.max(1, cut);
}

function chunkReplyText(text, limit = 3_500) {
  const normalized = normalizeWeixinReplyText(text);
  if (!normalized.trim()) return [];
  const chunks = [];
  let remaining = normalized;
  while (remaining.length > limit) {
    const minBoundary = Math.floor(limit * 0.4);
    const cut = findLastPreferredBoundary(remaining, limit, minBoundary)
      || adjustHardCutBoundary(remaining, limit);
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut);
  }
  if (remaining) chunks.push(remaining);
  return chunks.filter(Boolean);
}

function chunkReplyTextForWeixin(text) {
  const normalized = normalizeWeixinReplyText(text);
  if (!normalized.trim()) return [];
  const chunks = [];
  for (const block of splitAtBlankLineBoundaries(normalized)) {
    const boundaries = collectStreamingBoundaries(block);
    const units = boundaries.length ? splitTextAtBoundaries(block, boundaries) : [block];
    for (const unit of units) {
      if (unit.length <= MAX_WEIXIN_CHUNK) chunks.push(unit);
      else chunks.push(...chunkReplyText(unit, MAX_WEIXIN_CHUNK));
    }
  }
  return chunks.filter(Boolean);
}

function packChunkGroupsForWeixinDelivery(groups, maxMessages = WEIXIN_MAX_DELIVERY_MESSAGES, maxChunkChars = MAX_WEIXIN_CHUNK) {
  const packedGroups = groups.map((group) => group.map(normalizeLineEndings).filter((chunk) => chunk.trim()));
  let total = packedGroups.reduce((sum, group) => sum + group.length, 0);
  while (total > maxMessages) {
    let bestGroup = -1;
    let bestIndex = -1;
    let bestLength = Number.POSITIVE_INFINITY;
    for (let groupIndex = 0; groupIndex < packedGroups.length; groupIndex += 1) {
      const group = packedGroups[groupIndex];
      for (let index = 0; index < group.length - 1; index += 1) {
        const combinedLength = group[index].length + group[index + 1].length;
        if (combinedLength <= maxChunkChars && combinedLength < bestLength) {
          bestGroup = groupIndex;
          bestIndex = index;
          bestLength = combinedLength;
        }
      }
    }
    if (bestGroup < 0) break;
    const group = packedGroups[bestGroup];
    group.splice(bestIndex, 2, `${group[bestIndex]}${group[bestIndex + 1]}`);
    total -= 1;
  }

  const packed = packedGroups.flat();
  while (packed.length > maxMessages) {
    let bestIndex = -1;
    let bestLength = Number.POSITIVE_INFINITY;
    for (let index = 0; index < packed.length - 1; index += 1) {
      const combinedLength = packed[index].length + 2 + packed[index + 1].length;
      if (combinedLength <= maxChunkChars && combinedLength < bestLength) {
        bestIndex = index;
        bestLength = combinedLength;
      }
    }
    if (bestIndex < 0) break;
    packed.splice(bestIndex, 2, `${packed[bestIndex]}\n\n${packed[bestIndex + 1]}`);
  }
  return packed;
}

function prepareWeixinDeliveryChunks(text) {
  const normalized = normalizeWeixinReplyText(text);
  const groups = splitAtBlankLineBoundaries(normalized).map((block) => {
    const chunks = chunkReplyTextForWeixin(block);
    return chunks.length ? chunks : ["Completed."];
  });
  if (!groups.length) return ["Completed."];
  return packChunkGroupsForWeixinDelivery(groups);
}

function resolveWeixinChunkDelayMs(text, baseDelayMs = DEFAULT_CHUNK_DELAY_MS, random = Math.random) {
  const configuredBase = Number(baseDelayMs);
  const base = Math.max(DEFAULT_CHUNK_DELAY_MS, Number.isFinite(configuredBase) ? configuredBase : DEFAULT_CHUNK_DELAY_MS);
  const visibleLength = Array.from(String(text || "").trim()).length;
  const lengthDelay = Math.min(2_800, visibleLength * 14);
  const randomValue = Math.max(0, Math.min(0.999999, Number(random()) || 0));
  const jitter = Math.floor(randomValue * 701);
  return Math.min(5_000, Math.round(base + lengthDelay + jitter));
}

function publicEvent(event) {
  return {
    eventId: event.eventId,
    name: event.name,
    timestamp: event.timestamp,
    data: structuredClone(event.data),
    cursor: null,
  };
}

function redactInbound(event) {
  if (!event) return null;
  return {
    eventId: event.eventId,
    channelId: event.data?.channel_id,
    messageIdHash: sha256(event.data?.message_id ?? "").slice(0, 16),
    textSha256: sha256(event.data?.text ?? ""),
    receivedAt: event.timestamp,
  };
}

function redactReceipt(receipt) {
  if (!receipt) return null;
  return {
    eventId: receipt.eventId,
    idempotencyKey: receipt.idempotencyKey,
    textSha256: receipt.textSha256,
    status: receipt.status,
    attempts: receipt.attempts,
    chunkCount: receipt.chunkCount,
    createdAt: receipt.createdAt,
    completedAt: receipt.completedAt || null,
    errorCode: receipt.errorCode || "",
  };
}

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function classifySendError(error) {
  const message = String(error?.message ?? "").toLowerCase();
  if (message.includes("context_token")) return "missing_context_token";
  if (message.includes("ret=-2")) return "ilink_prepare_rejected";
  if (message.includes("abort") || message.includes("timeout")) return "timeout";
  return "send_failed";
}

export {
  EVENT_NAME,
  MAX_WEIXIN_CHUNK,
  WEIXIN_MAX_DELIVERY_MESSAGES,
  chunkReplyText,
  chunkReplyTextForWeixin,
  collectStreamingBoundaries,
  finalizeWeixinDeliveryChunk,
  packChunkGroupsForWeixinDelivery,
  prepareWeixinDeliveryChunks,
  resolveWeixinChunkDelayMs,
};
