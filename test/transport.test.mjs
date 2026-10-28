import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Webhook } from "standardwebhooks";
import { createMcpApp, assertSafeCallbackUrl } from "../src/mcp-app.mjs";
import { createHttpServer } from "../src/server.mjs";
import { ILinkClient } from "../src/ilink-client.mjs";
import { StateStore } from "../src/state-store.mjs";
import {
  WeChatTransport,
  chunkReplyTextForWeixin,
  finalizeWeixinDeliveryChunk,
  prepareWeixinDeliveryChunks,
  resolveWeixinChunkDelayMs,
} from "../src/transport.mjs";

function fixture(options = {}) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "wwit-"));
  const store = new StateStore({ stateDir });
  const sent = [];
  const ilinkClient = options.ilinkClient || {
    async sendText(value) { sent.push(value); return { ret: 0 }; },
    async getUpdates() { return { ret: 0, msgs: [], get_updates_buf: "" }; },
  };
  const transport = new WeChatTransport({
    store,
    ilinkClient,
    accountId: options.accountId || "",
    mode: options.mode || "simulation",
    channelId: "second-wechat",
    now: options.now || (() => new Date("2026-10-27T00:00:00.000Z")),
    chunkDelayMs: 0,
  });
  return { stateDir, store, transport, ilinkClient, sent, cleanup: () => fs.rmSync(stateDir, { recursive: true, force: true }) };
}

function inbound(overrides = {}) {
  return {
    from_user_id: "wx-user-1",
    message_id: "message-1",
    client_id: "client-1",
    message_type: 1,
    create_time_ms: Date.parse("2026-10-27T00:00:00.000Z"),
    context_token: "context-1",
    item_list: [{ type: 1, text_item: { text: "你好" } }],
    ...overrides,
  };
}

function value(result) {
  return result.structuredContent;
}

test("discovery exposes the real event and only bounded transport tools", async (t) => {
  const f = fixture();
  t.after(f.cleanup);
  const app = createMcpApp({ store: f.store, transport: f.transport });
  const events = await app.handleRpc("events/list", {}, { scopes: ["wechat:read"] });
  const tools = await app.handleRpc("tools/list", {}, { scopes: ["wechat:read"] });
  assert.deepEqual(events.events.map((item) => item.name), ["wechat.message.received"]);
  assert.deepEqual(tools.tools.map((item) => item.name), ["get_transport_status", "get_pending_wechat_messages", "send_wechat_reply"]);
  assert.equal(tools.tools[1].annotations.readOnlyHint, true);
  assert.equal(tools.tools[2].annotations.destructiveHint, true);
  assert.equal(tools.tools[2].annotations.idempotentHint, true);
});

test("iLink QR login uses the current POST contract and supports redirect verification", async () => {
  const calls = [];
  const client = new ILinkClient({
    fetchFn: async (url, options) => {
      calls.push({ url: String(url), method: options.method, headers: options.headers, body: options.body });
      if (String(url).includes("get_bot_qrcode")) {
        return new Response(JSON.stringify({ ret: 0, qrcode: "qr-1", qrcode_img_content: "https://weixin.qq.com/x/qr-1" }));
      }
      return new Response(JSON.stringify({ ret: 0, status: "scaned_but_redirect", redirect_host: "ilink-idc.weixin.qq.com" }));
    },
  });
  const qr = await client.fetchQrCode(undefined, "3", ["old-token"]);
  const status = await client.pollQrStatus("https://ilink-idc.weixin.qq.com", qr.qrcode, "123456");
  assert.equal(calls[0].method, "POST");
  assert.deepEqual(JSON.parse(calls[0].body), { local_token_list: ["old-token"] });
  assert.equal(calls[0].headers["iLink-App-Id"], "bot");
  assert.equal(calls[0].headers["iLink-App-ClientVersion"], "256");
  assert.equal(calls[0].headers.AuthorizationType, "ilink_bot_token");
  assert.ok(calls[0].headers["X-WECHAT-UIN"]);
  assert.equal("Content-Length" in calls[0].headers, false);
  assert.match(calls[1].url, /verify_code=123456/);
  assert.equal(calls[1].headers["iLink-App-Id"], "bot");
  assert.equal(calls[1].headers["iLink-App-ClientVersion"], "256");
  assert.equal(status.redirect_host, "ilink-idc.weixin.qq.com");
});

test("iLink lifecycle notifications use the saved real account and current protocol", async (t) => {
  const calls = [];
  const client = new ILinkClient({
    fetchFn: async (url, options) => {
      calls.push({ url: String(url), headers: options.headers, body: JSON.parse(options.body) });
      return new Response(JSON.stringify({ ret: 0 }));
    },
  });
  const f = fixture({ mode: "real", accountId: "account-1", ilinkClient: client });
  t.after(f.cleanup);
  f.transport.pollingEnabled = true;
  f.store.saveAccount("account-1", { token: "bot-secret", baseUrl: "https://ilink.example" });
  await f.transport.start();
  await f.transport.stop();
  assert.deepEqual(calls.map((item) => new URL(item.url).pathname), [
    "/ilink/bot/msg/notifystart",
    "/ilink/bot/msg/notifystop",
  ]);
  assert.deepEqual(calls.map((item) => item.body), [
    { base_info: { channel_version: "0.1.0" } },
    { base_info: { channel_version: "0.1.0" } },
  ]);
  assert.ok(calls.every((item) => item.headers.Authorization === "Bearer bot-secret"));
});

test("signed inbound event reaches a matching subscription and preserves user text as data", async (t) => {
  const f = fixture();
  t.after(f.cleanup);
  const secret = `whsec_${Buffer.alloc(32, 4).toString("base64")}`;
  const received = [];
  const fetchFn = async (_url, options) => {
    const headers = Object.fromEntries(Object.entries(options.headers).map(([key, item]) => [key.toLowerCase(), item]));
    const parsed = new Webhook(secret).verify(options.body, headers);
    if (parsed.type === "verification") return new Response(JSON.stringify({ challenge: parsed.challenge }), { status: 200 });
    received.push(parsed);
    return new Response("", { status: 202 });
  };
  const app = createMcpApp({
    store: f.store,
    transport: f.transport,
    fetchFn,
    resolveHost: async () => [{ address: "8.8.8.8", family: 4 }],
    retryDelaysMs: [0],
  });
  f.transport.setEventHandler(app.deliverEvent);
  await app.handleRpc("events/subscribe", {
    name: "wechat.message.received",
    arguments: { channel_id: "second-wechat" },
    delivery: { mode: "webhook", url: "https://events.example.test/callback", secret },
  }, { principal: "owner", scopes: ["wechat:read"] });
  const event = await f.transport.acceptRawMessage(inbound(), { accountId: "simulation-account" });
  assert.equal(received.length, 1);
  assert.equal(received[0].eventId, event.eventId);
  assert.equal(received[0].data.text, "你好");
  assert.equal("context_token" in received[0].data, false);
});

test("sender filters are applied before webhook delivery", async (t) => {
  const f = fixture();
  t.after(f.cleanup);
  const secret = `whsec_${Buffer.alloc(32, 5).toString("base64")}`;
  let applicationDeliveries = 0;
  const fetchFn = async (_url, options) => {
    const headers = Object.fromEntries(Object.entries(options.headers).map(([key, item]) => [key.toLowerCase(), item]));
    const parsed = new Webhook(secret).verify(options.body, headers);
    if (parsed.type === "verification") return new Response(JSON.stringify({ challenge: parsed.challenge }), { status: 200 });
    applicationDeliveries += 1;
    return new Response("", { status: 200 });
  };
  const app = createMcpApp({ store: f.store, transport: f.transport, fetchFn, resolveHost: async () => [{ address: "8.8.8.8", family: 4 }] });
  f.transport.setEventHandler(app.deliverEvent);
  await app.handleRpc("events/subscribe", {
    name: "wechat.message.received",
    arguments: { channel_id: "second-wechat", sender_id: "someone-else" },
    delivery: { mode: "webhook", url: "https://events.example.test/callback", secret },
  }, { principal: "owner", scopes: ["wechat:read"] });
  await f.transport.acceptRawMessage(inbound(), { accountId: "simulation-account" });
  assert.equal(applicationDeliveries, 0);
});

test("simulation reply is idempotent and destination-bound", async (t) => {
  const f = fixture();
  t.after(f.cleanup);
  const event = await f.transport.acceptRawMessage(inbound(), { accountId: "simulation-account" });
  const args = { eventId: event.eventId, toUserId: "wx-user-1", text: "回复", idempotencyKey: `reply:${event.eventId}` };
  const first = await f.transport.sendReply(args);
  const second = await f.transport.sendReply(args);
  assert.equal(first.dryRun, true);
  assert.equal(first.externalSideEffects, 0);
  assert.equal(second.duplicate, true);
  await assert.rejects(f.transport.sendReply({ ...args, toUserId: "other-user", idempotencyKey: "different" }), /must match/);
});

test("scheduled polling tool returns oldest pending messages and removes them only after a successful reply", async (t) => {
  const f = fixture();
  t.after(f.cleanup);
  const app = createMcpApp({ store: f.store, transport: f.transport });
  const first = await f.transport.acceptRawMessage(inbound(), { accountId: "simulation-account" });
  const second = await f.transport.acceptRawMessage(inbound({
    message_id: "message-2",
    client_id: "client-2",
    create_time_ms: Date.parse("2026-10-27T00:00:01.000Z"),
    item_list: [{ type: 1, text_item: { text: "第二条" } }],
  }), { accountId: "simulation-account" });

  const pending = value(await app.handleRpc("tools/call", {
    name: "get_pending_wechat_messages",
    arguments: { channel_id: "second-wechat", limit: 1 },
  }, { scopes: ["wechat:read"] }));
  assert.equal(pending.pending_count, 2);
  assert.equal(pending.truncated, true);
  assert.deepEqual(pending.messages[0], {
    event_id: first.eventId,
    sender_id: "wx-user-1",
    conversation_id: "wx-user-1",
    text: "你好",
    received_at: "2026-10-27T00:00:00.000Z",
  });
  assert.equal("context_token" in pending.messages[0], false);

  await f.transport.sendReply({
    eventId: first.eventId,
    toUserId: "wx-user-1",
    text: "第一条回复",
    idempotencyKey: `reply:${first.eventId}`,
  });
  const afterReply = f.transport.pendingMessages({ limit: 10 });
  assert.equal(afterReply.count, 1);
  assert.equal(afterReply.messages[0].eventId, second.eventId);
});

test("concurrent identical real replies share one in-flight write", async (t) => {
  let sends = 0;
  const ilinkClient = {
    async sendText() {
      sends += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { ret: 0 };
    },
    async getUpdates() { return { ret: 0, msgs: [], get_updates_buf: "" }; },
  };
  const f = fixture({ mode: "real", accountId: "account-1", ilinkClient });
  t.after(f.cleanup);
  f.store.saveAccount("account-1", { token: "bot-secret", baseUrl: "https://ilink.example" });
  const event = await f.transport.acceptRawMessage(inbound(), { accountId: "account-1" });
  const args = { eventId: event.eventId, toUserId: "wx-user-1", text: "并发回复", idempotencyKey: `reply:${event.eventId}` };
  const [first, second] = await Promise.all([f.transport.sendReply(args), f.transport.sendReply(args)]);
  assert.equal(sends, 1);
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(second.externalSideEffects, 0);
});

test("real reply uses the event account, saved context token, and stable client id", async (t) => {
  const f = fixture({ mode: "real", accountId: "account-1" });
  t.after(f.cleanup);
  f.store.saveAccount("account-1", { token: "bot-secret", baseUrl: "https://ilink.example", userId: "bot-user" });
  const event = await f.transport.acceptRawMessage(inbound(), { accountId: "account-1" });
  const args = { eventId: event.eventId, toUserId: "wx-user-1", text: "真实回复", idempotencyKey: `reply:${event.eventId}` };
  const first = await f.transport.sendReply(args);
  const second = await f.transport.sendReply(args);
  assert.equal(first.externalSideEffects, 1);
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].contextToken, "context-1");
  assert.match(f.sent[0].clientId, /^wwit-/);
  assert.match(f.sent[0].runId, /^wwit-run-/);
  assert.equal(second.duplicate, true);
});

test("reply splitting matches the current CC natural-boundary rules", () => {
  assert.deepEqual(chunkReplyTextForWeixin("第一句。第二句。"), ["第一句。", "第二句。"]);
  assert.deepEqual(chunkReplyTextForWeixin("第一件事结束。\n\n第二件事开始。"), [
    "第一件事结束。",
    "第二件事开始。",
  ]);
  assert.equal(finalizeWeixinDeliveryChunk("A。\nB。"), "A。\nB");
});

test("CC-compatible packing preserves content and limits ordinary replies to nine bubbles", () => {
  const text = Array.from({ length: 16 }, (_, index) => `话题${index + 1}结束。`).join("\n \n");
  const chunks = prepareWeixinDeliveryChunks(text);
  assert.equal(chunks.length, 9);
  assert.equal(chunks.join("\n\n"), text.replace(/\n \n/g, "\n\n"));
  assert.ok(chunks.every((chunk) => chunk.length <= 3_800));
});

test("CC-compatible chunk delay grows with text length and remains bounded", () => {
  assert.equal(resolveWeixinChunkDelayMs("短句", 1_500, () => 0), 1_528);
  assert.equal(resolveWeixinChunkDelayMs("短句", 1_500, () => 0.999999), 2_228);
  assert.equal(resolveWeixinChunkDelayMs("长".repeat(500), 3_000, () => 0.999999), 5_000);
});

test("natural reply bubbles share one logical run id and keep distinct client ids", async (t) => {
  const f = fixture({ mode: "real", accountId: "account-1" });
  t.after(f.cleanup);
  f.store.saveAccount("account-1", { token: "bot-secret", baseUrl: "https://ilink.example" });
  const event = await f.transport.acceptRawMessage(inbound(), { accountId: "account-1" });
  const result = await f.transport.sendReply({
    eventId: event.eventId,
    toUserId: "wx-user-1",
    text: "第一句。第二句。",
    idempotencyKey: `reply:${event.eventId}`,
  });
  assert.equal(result.chunkCount, 2);
  assert.deepEqual(f.sent.map((item) => item.text), ["第一句", "第二句"]);
  assert.equal(new Set(f.sent.map((item) => item.runId)).size, 1);
  assert.equal(new Set(f.sent.map((item) => item.clientId)).size, 2);
});

test("message deduplication and context tokens survive a store restart", async (t) => {
  const f = fixture();
  t.after(f.cleanup);
  const first = await f.transport.acceptRawMessage(inbound(), { accountId: "simulation-account" });
  const reopenedStore = new StateStore({ stateDir: f.stateDir });
  const reopened = new WeChatTransport({ store: reopenedStore, ilinkClient: f.ilinkClient, mode: "simulation", channelId: "second-wechat" });
  const duplicate = await reopened.acceptRawMessage(inbound(), { accountId: "simulation-account" });
  assert.ok(first);
  assert.equal(duplicate, null);
  assert.equal(reopenedStore.getContextToken("simulation-account", "wx-user-1"), "context-1");
});

test("bot messages are ignored to prevent a reply feedback loop", async (t) => {
  const f = fixture();
  t.after(f.cleanup);
  assert.equal(await f.transport.acceptRawMessage(inbound({ message_type: 2 })), null);
});

test("pollOnce persists sync buffer only after messages are accepted", async (t) => {
  const ilinkClient = {
    async getUpdates() { return { ret: 0, msgs: [inbound()], get_updates_buf: "next-buffer" }; },
    async sendText() { return { ret: 0 }; },
  };
  const f = fixture({ mode: "real", accountId: "account-1", ilinkClient });
  t.after(f.cleanup);
  f.store.saveAccount("account-1", { token: "secret", baseUrl: "https://ilink.example" });
  const result = await f.transport.pollOnce({ timeoutMs: 10 });
  assert.equal(result.acceptedCount, 1);
  assert.equal(f.store.getSyncBuffer("account-1"), "next-buffer");
});

test("OAuth DCR, explicit consent, PKCE, token exchange, and authenticated MCP call work", async (t) => {
  const f = fixture();
  t.after(f.cleanup);
  const app = createMcpApp({ store: f.store, transport: f.transport });
  const routeToken = "r".repeat(40);
  const server = createHttpServer(app, { store: f.store, routeToken });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const resource = `${base}/${routeToken}/mcp`;
  const redirectUri = "https://chatgpt.com/connector_platform_oauth_redirect";
  const registration = await (await fetch(`${base}/${routeToken}/oauth/register`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ redirect_uris: [redirectUri], client_name: "test" }),
  })).json();
  const verifier = "v".repeat(64);
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const authorizeUrl = new URL(`${base}/${routeToken}/oauth/authorize`);
  authorizeUrl.search = new URLSearchParams({
    response_type: "code", client_id: registration.client_id, redirect_uri: redirectUri, state: "state-1",
    code_challenge: challenge, code_challenge_method: "S256", resource, scope: "wechat:read wechat:reply",
  }).toString();
  const consentPage = await (await fetch(authorizeUrl)).text();
  assert.match(consentPage, /name="client_id"/);
  assert.doesNotMatch(consentPage, /name="clientId"/);
  const consent = await fetch(`${base}/${routeToken}/oauth/authorize`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      response_type: "code", client_id: registration.client_id, redirect_uri: redirectUri, state: "state-1",
      code_challenge: challenge, code_challenge_method: "S256", resource, scope: "wechat:read wechat:reply",
    }),
  });
  assert.equal(consent.status, 302);
  const callback = new URL(consent.headers.get("location"));
  const token = await (await fetch(`${base}/${routeToken}/oauth/token`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({
      grant_type: "authorization_code", code: callback.searchParams.get("code"), client_id: registration.client_id,
      redirect_uri: redirectUri, code_verifier: verifier, resource,
    }),
  })).json();
  assert.match(token.access_token, /^wwit_at_/);
  const rpc = await (await fetch(resource, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token.access_token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  })).json();
  assert.deepEqual(rpc.result.tools.map((item) => item.name), ["get_transport_status", "get_pending_wechat_messages", "send_wechat_reply"]);
  const reopened = new StateStore({ stateDir: f.stateDir });
  assert.equal(Object.keys(reopened.state.oauth.accessTokens).length, 1);
});

test("an App-backed legacy MCP path can authorize against the same isolated transport", async (t) => {
  const f = fixture();
  t.after(f.cleanup);
  const app = createMcpApp({ store: f.store, transport: f.transport });
  const routeToken = "n".repeat(40);
  const legacyPath = `/${"l".repeat(40)}/oauth-mcp`;
  const legacyOAuthPath = `/${"l".repeat(40)}/oauth`;
  const legacyClientId = "legacy_static_client";
  const server = createHttpServer(app, {
    store: f.store,
    routeToken,
    mcpAliases: [legacyPath],
    oauthAliases: [legacyOAuthPath],
    legacyClientIds: [legacyClientId],
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const resource = `${base}${legacyPath}`;
  const metadata = await (await fetch(`${base}/.well-known/oauth-protected-resource${legacyPath}`)).json();
  assert.equal(metadata.resource, resource);

  const redirectUri = "https://chatgpt.com/connector_platform_oauth_redirect";
  const verifier = "z".repeat(64);
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const consent = await fetch(`${base}${legacyOAuthPath}/authorize`, {
    method: "POST", redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      response_type: "code", client_id: legacyClientId, redirect_uri: redirectUri, state: "legacy-state",
      code_challenge: challenge, code_challenge_method: "S256", resource, scope: "poc:read poc:write",
    }),
  });
  const callback = new URL(consent.headers.get("location"));
  const token = await (await fetch(`${base}${legacyOAuthPath}/token`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code", code: callback.searchParams.get("code"), client_id: legacyClientId,
      redirect_uri: redirectUri, code_verifier: verifier, resource,
    }),
  })).json();
  assert.equal(token.scope, "poc:read poc:write");
  const rpc = await (await fetch(resource, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token.access_token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "events/list", params: {} }),
  })).json();
  assert.deepEqual(rpc.result.events.map((item) => item.name), ["wechat.message.received"]);
});

test("simulation injection is available only through the direct loopback admin route", async (t) => {
  const f = fixture();
  t.after(f.cleanup);
  const app = createMcpApp({ store: f.store, transport: f.transport });
  f.transport.setEventHandler(app.deliverEvent);
  const routeToken = "i".repeat(40);
  const server = createHttpServer(app, { store: f.store, transport: f.transport, routeToken });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${base}/${routeToken}/simulation/inject`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sender_id: "test-mobile", text: "测试事件" }),
  });
  const result = await response.json();
  assert.equal(response.status, 202);
  assert.equal(result.accepted, true);
  assert.match(result.event_id, /^evt_wechat_/);
  assert.equal(f.store.state.inboundEvents.at(-1).data.text, "测试事件");
});

test("private callback targets are rejected and official callback fake-IP is narrowly allowed", async () => {
  await assert.rejects(assertSafeCallbackUrl("https://example.test/cb", async () => [{ address: "127.0.0.1", family: 4 }]), /non-public/);
  const accepted = await assertSafeCallbackUrl("https://connectors.api.openai.com/cb", async () => [{ address: "198.18.1.3", family: 4 }]);
  assert.equal(accepted.hostname, "connectors.api.openai.com");
});

test("transient webhook failures retry with the same event id and a fresh signature", async (t) => {
  const f = fixture();
  t.after(f.cleanup);
  const secret = `whsec_${Buffer.alloc(32, 8).toString("base64")}`;
  const applicationIds = [];
  let applicationAttempts = 0;
  const fetchFn = async (_url, options) => {
    const headers = Object.fromEntries(Object.entries(options.headers).map(([key, item]) => [key.toLowerCase(), item]));
    const parsed = new Webhook(secret).verify(options.body, headers);
    if (parsed.type === "verification") return new Response(JSON.stringify({ challenge: parsed.challenge }), { status: 200 });
    applicationAttempts += 1;
    applicationIds.push(parsed.eventId);
    return new Response("", { status: applicationAttempts < 3 ? 503 : 202 });
  };
  const app = createMcpApp({ store: f.store, transport: f.transport, fetchFn, resolveHost: async () => [{ address: "8.8.8.8", family: 4 }], retryDelaysMs: [0, 0, 0] });
  f.transport.setEventHandler(app.deliverEvent);
  await app.handleRpc("events/subscribe", {
    name: "wechat.message.received", arguments: { channel_id: "second-wechat" },
    delivery: { mode: "webhook", url: "https://events.example.test/callback", secret },
  }, { principal: "owner", scopes: ["wechat:read"] });
  const event = await f.transport.acceptRawMessage(inbound(), { accountId: "simulation-account" });
  assert.equal(applicationAttempts, 3);
  assert.deepEqual(new Set(applicationIds), new Set([event.eventId]));
  assert.equal(f.store.state.deliveries.at(-1).accepted, true);
  assert.equal(f.store.state.deliveries.at(-1).attempts, 3);
});

test("unsubscribe is idempotent, persists, and stops future delivery", async (t) => {
  const f = fixture();
  t.after(f.cleanup);
  const secret = `whsec_${Buffer.alloc(32, 9).toString("base64")}`;
  let applications = 0;
  const callbackUrl = "https://events.example.test/callback";
  const fetchFn = async (_url, options) => {
    const headers = Object.fromEntries(Object.entries(options.headers).map(([key, item]) => [key.toLowerCase(), item]));
    const parsed = new Webhook(secret).verify(options.body, headers);
    if (parsed.type === "verification") return new Response(JSON.stringify({ challenge: parsed.challenge }), { status: 200 });
    applications += 1;
    return new Response("", { status: 200 });
  };
  const app = createMcpApp({ store: f.store, transport: f.transport, fetchFn, resolveHost: async () => [{ address: "8.8.8.8", family: 4 }] });
  f.transport.setEventHandler(app.deliverEvent);
  const params = { name: "wechat.message.received", arguments: { channel_id: "second-wechat" }, delivery: { mode: "webhook", url: callbackUrl, secret } };
  await app.handleRpc("events/subscribe", params, { principal: "owner", scopes: ["wechat:read"] });
  const unsubscribe = { name: params.name, arguments: params.arguments, delivery: { mode: "webhook", url: callbackUrl } };
  await app.handleRpc("events/unsubscribe", unsubscribe, { principal: "owner", scopes: ["wechat:read"] });
  await app.handleRpc("events/unsubscribe", unsubscribe, { principal: "owner", scopes: ["wechat:read"] });
  await f.transport.acceptRawMessage(inbound(), { accountId: "simulation-account" });
  assert.equal(applications, 0);
  assert.equal(new StateStore({ stateDir: f.stateDir }).state.subscriptions.length, 0);
});

test("real reply fails closed when no context token exists", async (t) => {
  const f = fixture({ mode: "real", accountId: "account-1" });
  t.after(f.cleanup);
  f.store.saveAccount("account-1", { token: "secret", baseUrl: "https://ilink.example" });
  const event = await f.transport.acceptRawMessage(inbound({ context_token: "" }), { accountId: "account-1" });
  await assert.rejects(f.transport.sendReply({
    eventId: event.eventId,
    toUserId: "wx-user-1",
    text: "reply",
    idempotencyKey: `reply:${event.eventId}`,
  }), /context_token/);
  assert.equal(f.sent.length, 0);
  assert.equal(f.store.state.writeReceipts.at(-1).errorCode, "missing_context_token");
});

test("write tool requires the reply OAuth scope", async (t) => {
  const f = fixture();
  t.after(f.cleanup);
  const app = createMcpApp({ store: f.store, transport: f.transport });
  const event = await f.transport.acceptRawMessage(inbound(), { accountId: "simulation-account" });
  await assert.rejects(app.handleRpc("tools/call", {
    name: "send_wechat_reply",
    arguments: { event_id: event.eventId, to_user_id: "wx-user-1", text: "reply", idempotency_key: `reply:${event.eventId}` },
  }, { scopes: ["wechat:read"] }), /OAuth scope required/);
});
