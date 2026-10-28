import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import QRCode from "qrcode";
import { ILinkClient } from "./ilink-client.mjs";
import { StateStore } from "./state-store.mjs";
import { redactSensitiveText } from "./util.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stateDir = process.env.TRANSPORT_STATE_DIR || path.join(ROOT, "runtime");
const command = process.argv[2] || "status";

if (command === "status") {
  const store = new StateStore({ stateDir });
  const state = store.snapshot();
  console.log(JSON.stringify({
    stateDir,
    subscriptions: state.subscriptions.length,
    inboundEvents: state.inboundEvents.length,
    successfulWrites: state.writeReceipts.filter((item) => item.status === "succeeded").length,
    savedAccounts: "redacted",
  }, null, 2));
} else if (command === "login") {
  await login();
} else {
  console.error("Usage: node src/cli.mjs [status|login]");
  process.exitCode = 2;
}

async function login() {
  const store = new StateStore({ stateDir });
  const client = new ILinkClient();
  const baseUrl = process.env.ILINK_BASE_URL || "https://ilinkai.weixin.qq.com";
  const botType = process.env.ILINK_QR_BOT_TYPE || "3";
  const deadline = Date.now() + 8 * 60_000;
  const qrPath = path.join(stateDir, "ilink-login-qr.png");
  await fs.mkdir(stateDir, { recursive: true });
  let qr = await refreshLoginQr(client, baseUrl, botType, qrPath);
  let pollBaseUrl = baseUrl;
  let verifyCode = "";
  let lastStatus = "";
  console.log(JSON.stringify({ waitingForScan: true, qrPath, totalWaitSeconds: 480 }));
  try {
    while (Date.now() < deadline) {
      let result;
      try { result = await client.pollQrStatus(pollBaseUrl, qr.qrcode, verifyCode); }
      catch (error) {
        if (String(error?.name) === "AbortError") continue;
        throw error;
      }
      if (result?.status && result.status !== lastStatus) {
        lastStatus = result.status;
        console.log(JSON.stringify({ loginStatus: result.status }));
      }
      if (result?.status === "scaned" && verifyCode) verifyCode = "";
      if (result?.status === "confirmed") {
        if (!result.bot_token || !result.ilink_bot_id) throw new Error("Login response is missing the account ID or bot token");
        const account = store.saveAccount(result.ilink_bot_id, {
          token: result.bot_token,
          baseUrl: result.baseurl || baseUrl,
          userId: result.ilink_user_id || "",
        });
        console.log(JSON.stringify({ connected: true, accountId: account.accountId, userIdConfigured: Boolean(account.userId) }));
        return;
      }
      if (result?.status === "expired") {
        qr = await refreshLoginQr(client, baseUrl, botType, qrPath);
        pollBaseUrl = baseUrl;
        verifyCode = "";
        lastStatus = "";
        console.log(JSON.stringify({ qrRefreshed: true, qrPath }));
        continue;
      }
      if (result?.status === "scaned_but_redirect") {
        pollBaseUrl = normalizeRedirectBaseUrl(result.redirect_host);
        console.log(JSON.stringify({ scanAccepted: true, redirected: true }));
        continue;
      }
      if (result?.status === "need_verifycode") {
        console.log(JSON.stringify({ verificationRequired: true }));
        verifyCode = await readVerifyCode();
        continue;
      }
      if (result?.status === "verify_code_blocked") throw new Error("Pairing code verification was blocked; start login again later");
      if (result?.status === "binded_redirect") throw new Error("This WeChat account is already bound to another iLink bot login");
    }
    throw new Error("Login timed out; no account state was saved");
  } finally {
    await fs.rm(qrPath, { force: true });
  }
}

async function refreshLoginQr(client, baseUrl, botType, qrPath) {
  const qr = await client.fetchQrCode(baseUrl, botType, []);
  await QRCode.toFile(qrPath, qr.qrcode_img_content, { width: 480, margin: 2, errorCorrectionLevel: "M" });
  try { await fs.chmod(qrPath, 0o600); } catch {}
  return qr;
}

function normalizeRedirectBaseUrl(value) {
  const host = String(value || "").trim();
  if (!/^[a-z0-9.-]+$/i.test(host) || host === "localhost" || host.endsWith(".local")) {
    throw new Error("iLink returned an invalid redirect host");
  }
  return `https://${host}`;
}

async function readVerifyCode() {
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const code = String(await readline.question("Enter the pairing digits shown in WeChat: ")).trim();
    if (!/^\d{4,8}$/.test(code)) throw new Error("Pairing code must contain 4-8 digits");
    return code;
  } finally {
    readline.close();
  }
}

process.on("uncaughtException", (error) => {
  console.error(redactSensitiveText(error?.message || error));
  process.exitCode = 1;
});
