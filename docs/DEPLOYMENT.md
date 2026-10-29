# Deployment

## Isolation

Use a dedicated Linux user, install directory, state directory, configuration directory, loopback port and systemd service. Do not reuse another bot's runtime state or credentials.

Suggested layout:

```text
/opt/wechat-work-ilink-transport
/var/lib/wechat-work-ilink-transport
/etc/wechat-work-ilink-transport
127.0.0.1:8792
```

## Environment

Copy `.env.example` into a protected environment file and replace every placeholder. Keep permissions restricted to the service account. Real polling remains disabled until both the authorized account and `TRANSPORT_POLLING_ENABLED=true` are configured deliberately.

## HTTPS endpoint

The MCP server must be reachable through public HTTPS for ChatGPT/plugin use. The repository includes an ngrok-oriented service template only as an example. Replace `YOUR_RESERVED_DOMAIN.example.com` and configure the tunnel credential outside Git.

The route token is part of the private endpoint path. Generate a long random value; never publish or commit a deployed value.

## Plugin template

Edit `plugin-package/wechat-work-bridge/mcp.json` and replace:

```text
https://YOUR_PUBLIC_BASE/YOUR_ROUTE_TOKEN/mcp
```

Install the resulting private plugin in ChatGPT Work, complete OAuth consent, and verify read-only status before enabling a real account.

## systemd

Review both templates under `deploy/`, then install them under `/etc/systemd/system/`. The templates are examples and are not executed automatically by this repository.

## Verification order

1. `npm run check`
2. simulation listener and `/healthz`
3. OAuth/plugin discovery
4. signed webhook delivery in simulation
5. ClawBot QR login
6. natural inbound message, only after explicit authorization

Do not treat source presence, test success, deployment, backend send success, and user-visible receipt as the same result.
