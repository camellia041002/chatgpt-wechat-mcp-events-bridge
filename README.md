# ChatGPT WeChat MCP Events Bridge

一个独立、无模型的微信 iLink transport：把专用微信号收到的消息转换为 MCP Event，交给 ChatGPT Work 自动化生成回复，再通过事件绑定的幂等工具发回微信。

> 非官方实验项目，与 OpenAI、腾讯或微信没有隶属关系。请仅在你有权使用的账号和环境中部署，并自行确认相关服务条款、隐私与合规要求。

## 架构

```text
专用微信号
   │ iLink getupdates / sendmessage
   ▼
本项目（无模型 transport）
   ├─ 持久化事件与订阅
   ├─ MCP 2.0 + OAuth DCR/PKCE
   ├─ Standard Webhooks 签名投递
   ├─ pending 队列与有限重试
   └─ 事件绑定、幂等的回复工具
   │
   ▼
ChatGPT Work 事件自动化
   └─ 负责上下文、推理、工具调用与最终回复
```

transport 本身不运行语言模型，也不接管 ChatGPT 的上下文或记忆。

## 主要能力

- `wechat.message.received` MCP Event，支持 `channel_id` 和可选发送者过滤。
- `get_transport_status`：只读、脱敏的健康状态和计数。
- `get_pending_wechat_messages`：读取最早的未成功回复事件，不返回 iLink `context_token`。
- `send_wechat_reply`：只能回复事件原发送者，使用 `reply:<event_id>` 幂等键。
- webhook 签名、回调地址校验、有限重试、重启后持久化。
- 入站去重、并发幂等写、机器人消息回环保护。
- 自然分片：按段落、列表与句末标点切分，单片上限 3,800 字符。

## 安全默认值

- `TRANSPORT_MODE=simulation`
- `TRANSPORT_POLLING_ENABLED=false`
- 仅监听 `127.0.0.1`
- 运行状态、账号令牌、OAuth token、webhook secret 和消息上下文只存入被忽略的 `runtime/`
- 测试全部使用 fake iLink 与 fake webhook，不访问真实微信

## 本地验证

需要 Node.js 22.13 或更高版本。

```powershell
npm install
npm run check
```

启动默认关闭真实网络访问的模拟服务：

```powershell
.\scripts\start-simulation.ps1
```

停止该脚本记录的本地进程：

```powershell
.\scripts\stop-local.ps1
```

## 真实账号与部署

真实模式必须显式完成专用账号登录，并主动设置：

```text
TRANSPORT_MODE=real
TRANSPORT_ACCOUNT_ID=<dedicated-account-id>
TRANSPORT_POLLING_ENABLED=true
```

不要提交 `runtime/`、`.env`、二维码、账号文件或任何 token。Linux systemd、HTTPS tunnel 和插件模板见 [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)。ChatGPT 自动化规则见 [docs/AUTOMATION.md](docs/AUTOMATION.md)。

## 重要语义

- 新订阅只接收订阅建立之后的新事件；创建订阅不会自动 replay 已有 pending。
- pending 仅表示 transport 尚未记录成功回复，不代表 ChatGPT 会自动收到该事件。
- ChatGPT 的事件自动化拥有自己的运行上下文；本项目不保证继承其他聊天的完整历史。
- `send_wechat_reply` 成功与用户手机端实际看到消息是两个不同证据层级。

## License

[GNU Affero General Public License v3.0 only](LICENSE)。
