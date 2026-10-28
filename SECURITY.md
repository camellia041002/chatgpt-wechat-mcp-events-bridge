# Security policy

## Never commit

- WeChat/iLink account identifiers, tokens or QR codes
- OAuth access or refresh tokens
- webhook signing secrets
- MCP route tokens or private callback paths
- `context_token` values, sender identifiers or message logs
- exported `runtime/` state

Run the service as a dedicated operating-system user, bind it to loopback, and expose it only through a separately authenticated HTTPS endpoint. Use a dedicated test/secondary account rather than a primary personal account.

`send_wechat_reply` is deliberately bound to the sender recorded on the original inbound event. Do not remove destination binding or idempotency checks.

Please report security issues privately to the repository owner instead of opening a public issue containing credentials or reproduction data.
