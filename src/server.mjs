import crypto from "node:crypto";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ILinkClient } from "./ilink-client.mjs";
import { createMcpApp, rpcError } from "./mcp-app.mjs";
import { StateStore } from "./state-store.mjs";
import { WeChatTransport } from "./transport.mjs";
import { redactSensitiveText, sha256, sleep } from "./util.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MAX_BODY_BYTES = 256 * 1024;

export function createHttpServer(app, { store, transport = null, routeToken, mcpAliases = [], oauthAliases = [], legacyClientIds = [], externalBase = "" }) {
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(routeToken)) throw new Error("routeToken must be 32-128 URL-safe characters");
  const mcpPaths = normalizeMcpPaths(routeToken, mcpAliases);
  const oauthPaths = normalizeOAuthPaths(routeToken, oauthAliases);
  const allowedResourcePaths = new Set(mcpPaths);
  const allowedLegacyClientIds = new Set((legacyClientIds || []).map((item) => String(item).trim()).filter(Boolean));
  return http.createServer(async (request, response) => {
    try {
      const base = requestExternalBase(request, externalBase);
      const url = new URL(request.url || "/", base);
      const authBase = `${base}${oauthPaths[0]}`;
      const defaultResource = `${base}${mcpPaths[0]}`;

      if (request.method === "GET" && url.pathname === "/healthz") {
        return sendJson(response, 200, { ok: true, service: "wechat-work-ilink-transport", mode: "redacted" });
      }
      const metadataResourcePath = protectedMetadataResourcePath(url.pathname, mcpPaths);
      if (request.method === "GET" && metadataResourcePath) {
        return sendJson(response, 200, {
          resource: `${base}${metadataResourcePath}`,
          authorization_servers: [authBase],
          scopes_supported: ["wechat:read", "wechat:reply"],
          bearer_methods_supported: ["header"],
        });
      }
      const metadataOAuthPath = authorizationMetadataOAuthPath(url.pathname, oauthPaths);
      if (request.method === "GET" && metadataOAuthPath) {
        const metadataAuthBase = `${base}${metadataOAuthPath}`;
        return sendJson(response, 200, {
          issuer: metadataAuthBase,
          authorization_endpoint: `${metadataAuthBase}/authorize`,
          token_endpoint: `${metadataAuthBase}/token`,
          registration_endpoint: `${metadataAuthBase}/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
          scopes_supported: ["wechat:read", "wechat:reply"],
        });
      }
      const registerOAuthPath = oauthPathForEndpoint(url.pathname, oauthPaths, "register");
      if (request.method === "POST" && registerOAuthPath) {
        const input = JSON.parse(await readBody(request) || "{}");
        const redirectUris = validateRedirectUris(input.redirect_uris);
        const clientId = `wwit_client_${crypto.randomBytes(24).toString("base64url")}`;
        store.state.oauth.clients[clientId] = {
          clientId,
          redirectUris,
          clientName: String(input.client_name || "ChatGPT").slice(0, 120),
          createdAt: new Date().toISOString(),
        };
        store.save();
        return sendJson(response, 201, { client_id: clientId, redirect_uris: redirectUris, token_endpoint_auth_method: "none" });
      }
      const authorizeOAuthPath = oauthPathForEndpoint(url.pathname, oauthPaths, "authorize");
      if (authorizeOAuthPath) {
        if (request.method === "GET") return renderConsent(response, url, store, base, allowedResourcePaths, allowedLegacyClientIds);
        if (request.method === "POST") return approveConsent(response, await readForm(request), store, base, allowedResourcePaths, allowedLegacyClientIds);
      }
      const tokenOAuthPath = oauthPathForEndpoint(url.pathname, oauthPaths, "token");
      if (request.method === "POST" && tokenOAuthPath) {
        return tokenEndpoint(response, await readForm(request), store);
      }
      if (request.method === "POST" && mcpPaths.includes(url.pathname)) {
        const resource = `${base}${url.pathname}`;
        const auth = authenticateBearer(request, store, resource);
        if (!auth) return sendUnauthorized(response, `${base}/.well-known/oauth-protected-resource${url.pathname}`);
        const payload = JSON.parse(await readBody(request));
        const result = await app.handleRpc(payload.method, payload.params || {}, auth);
        return sendJson(response, 200, { jsonrpc: "2.0", id: payload.id ?? null, result });
      }
      if (request.method === "POST" && url.pathname === `/${routeToken}/simulation/inject`) {
        if (!transport || transport.mode !== "simulation") return sendJson(response, 404, { error: "not_found" });
        if (!isDirectLoopbackRequest(request)) return sendJson(response, 403, { error: "loopback_only" });
        const input = JSON.parse(await readBody(request) || "{}");
        const event = await transport.injectTestMessage({
          senderId: required(input.sender_id || "test-user", "sender_id", 256),
          text: required(input.text || "Test WeChat message", "text", 8_000),
          messageId: String(input.message_id || "").slice(0, 256),
        });
        return sendJson(response, 202, { accepted: Boolean(event), event_id: event?.eventId || null, resource: defaultResource });
      }
      return sendJson(response, 404, { error: "not_found" });
    } catch (error) {
      if (error instanceof SyntaxError) return sendJson(response, 400, { error: "invalid_json" });
      if (Number.isInteger(error?.code)) {
        return sendJson(response, 200, { jsonrpc: "2.0", id: null, error: { code: error.code, message: error.message, ...(error.data ? { data: error.data } : {}) } });
      }
      return sendJson(response, 500, { error: "internal_error", message: redactSensitiveText(error?.message || "Internal error", 160) });
    }
  });
}

function renderConsent(response, url, store, base, allowedResourcePaths, allowedLegacyClientIds) {
  const params = validateAuthorizationRequest(url.searchParams, store, base, allowedResourcePaths, allowedLegacyClientIds);
  const client = store.state.oauth.clients[params.clientId];
  const fields = Object.entries({
    response_type: "code",
    client_id: params.clientId,
    redirect_uri: params.redirectUri,
    state: params.state,
    code_challenge: params.codeChallenge,
    code_challenge_method: "S256",
    scope: params.scope,
    resource: params.resource,
  }).map(([key, value]) => `<input type="hidden" name="${html(key)}" value="${html(value)}">`).join("");
  const body = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Authorize WeChat Work Transport</title><style>body{font:16px system-ui;max-width:620px;margin:60px auto;padding:0 20px}button{font:inherit;padding:10px 18px}code{background:#eee;padding:2px 5px}</style><h1>Authorize isolated WeChat transport</h1><p><strong>${html(client.clientName)}</strong> requests <code>${html(params.scope)}</code>.</p><p>This connection can read events from the authorized WeChat account and send replies through the isolated transport. It does not access other services or memory stores.</p><form method="post">${fields}<button type="submit">Authorize</button></form></html>`;
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": Buffer.byteLength(body), "Cache-Control": "no-store", "X-Frame-Options": "DENY" });
  response.end(body);
}

function approveConsent(response, form, store, base, allowedResourcePaths, allowedLegacyClientIds) {
  const params = validateAuthorizationObject(form, store, base, allowedResourcePaths, allowedLegacyClientIds);
  const code = `wwit_code_${crypto.randomBytes(32).toString("base64url")}`;
  store.state.oauth.authCodes[code] = {
    clientId: params.clientId,
    redirectUri: params.redirectUri,
    codeChallenge: params.codeChallenge,
    resource: params.resource,
    scope: params.scope,
    principal: "owner",
    expiresAt: Date.now() + 5 * 60_000,
  };
  store.save();
  const redirect = new URL(params.redirectUri);
  redirect.searchParams.set("code", code);
  redirect.searchParams.set("state", params.state);
  response.writeHead(302, { Location: redirect.toString(), "Cache-Control": "no-store" });
  response.end();
}

function tokenEndpoint(response, form, store) {
  if (form.grant_type === "authorization_code") {
    const record = store.state.oauth.authCodes[form.code];
    if (!record || record.expiresAt <= Date.now()) return oauthError(response, "invalid_grant");
    if (record.clientId !== form.client_id || record.redirectUri !== form.redirect_uri) return oauthError(response, "invalid_grant");
    if (form.resource && record.resource !== form.resource) return oauthError(response, "invalid_target");
    const challenge = crypto.createHash("sha256").update(String(form.code_verifier || "")).digest("base64url");
    if (!timingSafeEqual(challenge, record.codeChallenge)) return oauthError(response, "invalid_grant");
    delete store.state.oauth.authCodes[form.code];
    return issueTokens(response, store, record);
  }
  if (form.grant_type === "refresh_token") {
    const record = store.state.oauth.refreshTokens[sha256(form.refresh_token)];
    if (!record || record.clientId !== form.client_id) return oauthError(response, "invalid_grant");
    if (form.resource && record.resource !== form.resource) return oauthError(response, "invalid_target");
    return issueTokens(response, store, record, form.refresh_token);
  }
  return oauthError(response, "unsupported_grant_type");
}

function issueTokens(response, store, record, existingRefreshToken = "") {
  const accessToken = `wwit_at_${crypto.randomBytes(32).toString("base64url")}`;
  const refreshToken = existingRefreshToken || `wwit_rt_${crypto.randomBytes(32).toString("base64url")}`;
  const accessRecord = { ...record, expiresAt: Date.now() + 60 * 60_000 };
  const refreshRecord = { ...record, expiresAt: undefined };
  store.state.oauth.accessTokens[sha256(accessToken)] = accessRecord;
  store.state.oauth.refreshTokens[sha256(refreshToken)] = refreshRecord;
  store.save();
  return sendJson(response, 200, {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: 3600,
    refresh_token: refreshToken,
    scope: record.scope,
  });
}

function authenticateBearer(request, store, resource) {
  const match = /^Bearer\s+(.+)$/i.exec(String(request.headers.authorization || ""));
  if (!match) return null;
  const record = store.state.oauth.accessTokens[sha256(match[1])];
  if (!record || record.expiresAt <= Date.now() || record.resource !== resource) return null;
  return { principal: record.principal, scopes: internalScopes(record.scope) };
}

function validateAuthorizationRequest(searchParams, store, base, allowedResourcePaths, allowedLegacyClientIds) {
  return validateAuthorizationObject(Object.fromEntries(searchParams), store, base, allowedResourcePaths, allowedLegacyClientIds);
}

function validateAuthorizationObject(value, store, base, allowedResourcePaths, allowedLegacyClientIds) {
  const clientId = required(value.client_id, "client_id", 200);
  const redirectUri = required(value.redirect_uri, "redirect_uri", 1_000);
  let client = store.state.oauth.clients[clientId];
  if (!client && allowedLegacyClientIds.has(clientId)) {
    const [validatedRedirectUri] = validateRedirectUris([redirectUri]);
    client = { clientId, redirectUris: [validatedRedirectUri], clientName: "ChatGPT legacy App connection", createdAt: new Date().toISOString(), legacy: true };
    store.state.oauth.clients[clientId] = client;
    store.save();
  }
  if (!client || !client.redirectUris.includes(new URL(redirectUri).toString())) throw new Error("invalid OAuth client or redirect URI");
  if (value.response_type !== "code" || value.code_challenge_method !== "S256") throw new Error("unsupported OAuth authorization request");
  const resourceUrl = new URL(required(value.resource, "resource", 2_000));
  if (resourceUrl.origin !== new URL(base).origin || !allowedResourcePaths.has(resourceUrl.pathname) || resourceUrl.search || resourceUrl.hash) throw new Error("invalid OAuth resource");
  return {
    clientId,
    redirectUri,
    state: required(value.state, "state", 500),
    codeChallenge: required(value.code_challenge, "code_challenge", 200),
    scope: normalizeScope(value.scope),
    resource: resourceUrl.toString(),
  };
}

function validateRedirectUris(value) {
  if (!Array.isArray(value) || !value.length || value.length > 10) throw new Error("redirect_uris are required");
  return value.map((item) => {
    const url = new URL(String(item));
    const allowedPath = url.pathname === "/connector_platform_oauth_redirect" || url.pathname.startsWith("/connector/oauth/");
    if (url.protocol !== "https:" || url.hostname !== "chatgpt.com" || !allowedPath || url.username || url.password) throw new Error("redirect_uri is not an allowed ChatGPT callback");
    return url.toString();
  });
}

function normalizeScope(value) {
  const requested = new Set(String(value || "wechat:read wechat:reply").split(/\s+/).filter(Boolean));
  const granted = ["wechat:read", "wechat:reply", "poc:read", "poc:write"].filter((scope) => requested.has(scope));
  return granted.length ? granted.join(" ") : "wechat:read wechat:reply";
}

function internalScopes(value) {
  const requested = new Set(String(value || "").split(/\s+/).filter(Boolean));
  const mapped = new Set();
  if (requested.has("wechat:read") || requested.has("poc:read")) mapped.add("wechat:read");
  if (requested.has("wechat:reply") || requested.has("poc:write")) mapped.add("wechat:reply");
  return [...mapped];
}

function required(value, label, maxLength) {
  const text = String(value || "");
  if (!text || text.length > maxLength) throw new Error(`${label} is required`);
  return text;
}

function normalizeMcpPaths(routeToken, aliases) {
  const paths = [`/${routeToken}/mcp`];
  for (const raw of aliases || []) {
    const value = String(raw || "").trim();
    if (!value) continue;
    if (!/^\/[A-Za-z0-9_./-]{1,220}$/.test(value) || value.includes("..") || value.endsWith("/")) throw new Error("MCP alias must be a bounded absolute URL path");
    if (!paths.includes(value)) paths.push(value);
  }
  return paths;
}

function normalizeOAuthPaths(routeToken, aliases) {
  const paths = [`/${routeToken}/oauth`];
  for (const raw of aliases || []) {
    const value = String(raw || "").trim();
    if (!value) continue;
    if (!/^\/[A-Za-z0-9_./-]{1,220}$/.test(value) || value.includes("..") || value.endsWith("/")) throw new Error("OAuth alias must be a bounded absolute URL path");
    if (!paths.includes(value)) paths.push(value);
  }
  return paths;
}

function protectedMetadataResourcePath(pathname, mcpPaths) {
  if (pathname === "/.well-known/oauth-protected-resource") return mcpPaths[0];
  for (const mcpPath of mcpPaths) {
    if (pathname === `/.well-known/oauth-protected-resource${mcpPath}` || pathname === `${mcpPath}/.well-known/oauth-protected-resource`) return mcpPath;
  }
  return "";
}

function authorizationMetadataOAuthPath(pathname, oauthPaths) {
  if (pathname === "/.well-known/oauth-authorization-server") return oauthPaths[0];
  for (const oauthPath of oauthPaths) {
    if (pathname === `/.well-known/oauth-authorization-server${oauthPath}` || pathname === `${oauthPath}/.well-known/oauth-authorization-server`) return oauthPath;
  }
  return "";
}

function oauthPathForEndpoint(pathname, oauthPaths, endpoint) {
  return oauthPaths.find((oauthPath) => pathname === `${oauthPath}/${endpoint}`) || "";
}

function requestExternalBase(request, configured) {
  if (configured) return configured.replace(/\/$/, "");
  const host = String(request.headers["x-forwarded-host"] || request.headers.host || "");
  if (!/^[A-Za-z0-9.-]+(?::\d{1,5})?$/.test(host)) throw new Error("invalid host header");
  const forwarded = String(request.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  const protocol = forwarded === "https" || !/^localhost(?::|$)|^127\.0\.0\.1(?::|$)/.test(host) ? "https" : "http";
  return `${protocol}://${host}`;
}

function isDirectLoopbackRequest(request) {
  if (request.headers.forwarded || request.headers["x-forwarded-for"] || request.headers["x-real-ip"]) return false;
  const address = String(request.socket.remoteAddress || "").replace(/^::ffff:/, "");
  return address === "127.0.0.1" || address === "::1";
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

async function readForm(request) {
  return Object.fromEntries(new URLSearchParams(await readBody(request)));
}

function sendUnauthorized(response, metadataUrl) {
  const body = JSON.stringify({ error: "unauthorized" });
  response.writeHead(401, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "WWW-Authenticate": `Bearer resource_metadata="${metadataUrl}", scope="wechat:read wechat:reply"`,
  });
  response.end(body);
}

function oauthError(response, error) {
  return sendJson(response, 400, { error });
}

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), "Cache-Control": "no-store" });
  response.end(body);
}

function timingSafeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function html(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

export function createRuntime(options = {}) {
  const stateDir = options.stateDir || process.env.TRANSPORT_STATE_DIR || path.join(ROOT, "runtime");
  const store = options.store || new StateStore({ stateDir });
  const ilinkClient = options.ilinkClient || new ILinkClient();
  const transport = options.transport || new WeChatTransport({
    store,
    ilinkClient,
    accountId: options.accountId ?? process.env.TRANSPORT_ACCOUNT_ID ?? "",
    channelId: options.channelId ?? process.env.TRANSPORT_CHANNEL_ID ?? "wechat",
    mode: options.mode ?? process.env.TRANSPORT_MODE ?? "simulation",
    pollingEnabled: options.pollingEnabled ?? process.env.TRANSPORT_POLLING_ENABLED === "true",
    mediaCdnBaseUrl: options.mediaCdnBaseUrl ?? process.env.TRANSPORT_WEIXIN_CDN_BASE_URL,
    mediaFetchFn: options.mediaFetchFn ?? fetch,
    serialEventDispatchEnabled: options.serialEventDispatchEnabled ?? process.env.TRANSPORT_SERIAL_EVENT_DISPATCH_ENABLED !== "false",
    eventAckTimeoutMs: options.eventAckTimeoutMs ?? Number(process.env.TRANSPORT_EVENT_ACK_TIMEOUT_MS || 75_000),
    eventSendTimeoutMs: options.eventSendTimeoutMs ?? Number(process.env.TRANSPORT_EVENT_SEND_TIMEOUT_MS || 300_000),
    eventRetryDelaysMs: options.eventRetryDelaysMs,
  });
  const app = createMcpApp({ store, transport, ...(options.mcpOptions || {}) });
  transport.setEventHandler(app.deliverEvent);
  return { store, ilinkClient, transport, app };
}

async function runMain() {
  const routeToken = String(process.env.TRANSPORT_ROUTE_TOKEN || "").trim();
  if (!routeToken) throw new Error("TRANSPORT_ROUTE_TOKEN is required");
  const port = Number(process.env.TRANSPORT_PORT || 8792);
  const host = process.env.TRANSPORT_HOST || "127.0.0.1";
  const runtime = createRuntime();
  const server = createHttpServer(runtime.app, {
    store: runtime.store,
    transport: runtime.transport,
    routeToken,
    mcpAliases: String(process.env.TRANSPORT_MCP_ALIASES || "").split(",").map((item) => item.trim()).filter(Boolean),
    oauthAliases: String(process.env.TRANSPORT_OAUTH_ALIASES || "").split(",").map((item) => item.trim()).filter(Boolean),
    legacyClientIds: String(process.env.TRANSPORT_LEGACY_OAUTH_CLIENT_IDS || "").split(",").map((item) => item.trim()).filter(Boolean),
    externalBase: process.env.TRANSPORT_EXTERNAL_BASE || "",
  });
  await new Promise((resolve) => server.listen(port, host, resolve));
  console.error(`wechat-work-ilink-transport listening on http://${host}:${port}/<redacted>/mcp`);
  runtime.transport.resumeEventDispatch();

  let stopping = false;
  const pollingEnabled = process.env.TRANSPORT_POLLING_ENABLED === "true";
  if (pollingEnabled) {
    try { await runtime.transport.start(); }
    catch (error) {
      console.error(`[transport] notifyStart failed: ${redactSensitiveText(error?.message || error, 240)}`);
    }
  }
  const pollPromise = pollingEnabled ? (async () => {
    while (!stopping) {
      try { await runtime.transport.pollOnce(); }
      catch (error) {
        console.error(`[transport] poll failed: ${redactSensitiveText(error?.message || error, 240)}`);
        await sleep(2_000);
      }
    }
  })() : Promise.resolve();

  const stop = () => {
    stopping = true;
    server.close();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  await new Promise((resolve) => server.once("close", resolve));
  await pollPromise;
  if (pollingEnabled) {
    try { await runtime.transport.stop(); }
    catch (error) {
      console.error(`[transport] notifyStop failed: ${redactSensitiveText(error?.message || error, 240)}`);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runMain().catch((error) => {
    console.error(redactSensitiveText(error?.message || error, 300));
    process.exitCode = 1;
  });
}
