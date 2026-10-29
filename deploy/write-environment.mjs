import fs from "node:fs";
import path from "node:path";

const stateDir = process.argv[2] || "/var/lib/wechat-work-ilink-transport";
const output = process.argv[3] || "/etc/wechat-work-ilink-transport/environment";
const externalBase = process.argv[4] || "";
const pollingEnabled = process.argv[5] === "true";

const connection = JSON.parse(fs.readFileSync(path.join(stateDir, "local-connection.json"), "utf8"));
const accountFiles = fs.readdirSync(path.join(stateDir, "accounts")).filter((name) => name.endsWith(".json"));
if (accountFiles.length !== 1) throw new Error("Expected exactly one isolated iLink account");
const account = JSON.parse(fs.readFileSync(path.join(stateDir, "accounts", accountFiles[0]), "utf8"));

const lines = [
  "TRANSPORT_HOST=127.0.0.1",
  "TRANSPORT_PORT=8792",
  `TRANSPORT_STATE_DIR=${stateDir}`,
  `TRANSPORT_ROUTE_TOKEN=${connection.routeToken}`,
  `TRANSPORT_MCP_ALIASES=${(connection.mcpAliasPaths || []).join(",")}`,
  `TRANSPORT_OAUTH_ALIASES=${(connection.oauthAliasPaths || []).join(",")}`,
  `TRANSPORT_LEGACY_OAUTH_CLIENT_IDS=${(connection.legacyOAuthClientIds || []).join(",")}`,
  `TRANSPORT_EXTERNAL_BASE=${externalBase}`,
  "TRANSPORT_CHANNEL_ID=wechat",
  "TRANSPORT_MODE=real",
  `TRANSPORT_ACCOUNT_ID=${account.accountId}`,
  `TRANSPORT_POLLING_ENABLED=${pollingEnabled}`,
  "ILINK_BASE_URL=https://ilinkai.weixin.qq.com",
  "ILINK_QR_BOT_TYPE=3",
];

fs.writeFileSync(output, `${lines.join("\n")}\n`, { mode: 0o640 });
