# ChatGPT WeChat MCP Events Bridge

一个独立、无模型的微信 iLink transport：把微信 ClawBot 收到的消息转换为 MCP Event，交给 ChatGPT Work 自动化生成回复，再通过事件绑定的幂等工具发回微信。

> 用任意一个微信号扫码授权 ClawBot 即可，不需要专门注册新号。注意一个微信号只能绑定一个 ClawBot，如果你的主号已经接了别的 Bot，可以换一个号来接。

> 非官方实验项目，与 OpenAI、腾讯或微信没有隶属关系。请仅在你有权使用的账号和环境中部署，并自行确认相关服务条款、隐私与合规要求。

## 架构

```text
微信 ClawBot（扫码授权的微信号）
   │ iLink getupdates / sendmessage
   ▼
本项目（无模型 transport）
   ├─ 有界图片下载、解密与私有存储
   ├─ 持久化事件与订阅
   ├─ MCP 2.0 + OAuth DCR/PKCE
   ├─ Standard Webhooks 签名投递
   ├─ 写回确认门控的串行事件队列
   ├─ pending 队列与受控重投
   └─ 事件绑定、幂等的回复工具
   │
   ▼
ChatGPT Work 事件自动化
   └─ 负责上下文、推理、工具调用与最终回复
```

transport 本身不运行语言模型，也不接管 ChatGPT 的上下文或记忆。

## ChatGPT 端适用范围

本项目已在 ChatGPT Work 网页端跑通。官方 MCP Events 文档还列明支持 Work Desktop Cloud 和 dot。2026-10-30，在本账号网页普通 Chat 的全新独立模拟测试中，普通 MCP 工具可以调用，但事件订阅返回 `404 Action not found`，未生成订阅；因此普通 Chat 的微信事件唤醒尚未验证通过。

| ChatGPT 环境 | 证据 | 本项目适用性 |
| --- | --- | --- |
| Work（网页） | 本项目实际跑通；官方文档列明支持 MCP Events | 已验证适用 |
| Work（桌面端选择 Cloud） | 官方文档列明支持 MCP Events；本项目未单独实测 | 文档支持，未单独验收 |
| dot | 官方文档列明支持 MCP Events；本项目未单独实测 | 文档支持，未单独验收 |
| 普通 Chat | 2026-10-30 本账号网页端可调用普通 MCP 工具，但未建立事件订阅 | 微信事件唤醒尚未验证通过 |

### 普通 Chat 实测记录

2026-10-30 使用全新、独立的 simulation-only POC 在本账号网页普通 Chat 中测试。POC 端点可发现，`get_poc_status` 也能正常返回；但尝试建立 `poc.test.created` 事件订阅时，Chat 宿主的订阅动作返回 `404 Action not found`，没有生成 `subscription_id`，POC 服务端订阅数仍为 0。失败点不是 POC 端点不可达，而是当次普通 Chat 未能建立事件订阅；这是一项带日期和账号范围的实测结果，不代表未来版本的永久结论。

插件在目录中可见或普通工具可调用，都不等于 MCP Events 已接通。

如果必须使用普通 Chat，只能另行设计轮询，或由外部后端主动调用模型/API；这两种方案都不等同于 MCP Events 对既有聊天窗口的原生事件唤醒。

## 主要能力

- `wechat.message.received` MCP Event，支持文本、语音转写与图片，并可按 `channel_id` 和发送者过滤。
- `get_transport_status`：只读、脱敏的健康状态和计数。
- `get_pending_wechat_messages`：读取最早的未成功回复事件，不返回 iLink `context_token`。
- `get_wechat_image`：按事件 ID 与零起始索引读取一张已校验图片，以 MCP image content block 返回。
- `send_wechat_reply`：只能回复事件原发送者，使用 `reply:<event_id>` 幂等键。
- webhook 签名、回调地址校验、有限重试、重启后持久化。
- 入站去重、并发幂等写、机器人消息回环保护。
- 新事件按顺序投递；上一事件出现成功写回回执后才投递下一事件。回执超时时以新的 webhook delivery ID 重投同一原事件，仍强制使用原事件幂等键。
- 图片最多每事件 4 张、每张 20 MiB，仅允许 HTTPS 可信媒体主机，并校验 PNG/JPEG/GIF/WebP 内容；媒体 URL、解密密钥与图片字节不会进入 webhook 事件。
- 自然分片：按段落、列表与句末标点切分，单片上限 3,800 字符。

## 安全默认值

- `TRANSPORT_MODE=simulation`
- `TRANSPORT_POLLING_ENABLED=false`
- 仅监听 `127.0.0.1`
- 运行状态、账号令牌、OAuth token、webhook secret 和消息上下文只存入被忽略的 `runtime/`
- 图片仅存入隔离的运行状态目录，目录和文件采用私有权限
- 测试全部使用 fake iLink 与 fake webhook，不访问真实微信

## 本地验证

需要 Node.js 22.13 或更高版本。

```powershell
npm install
npm run check
```

当前回归集包含 28 项测试，覆盖图片读取、串行确认门控、回执超时重投、历史 pending 隔离与幂等写回。

启动默认关闭真实网络访问的模拟服务：

```powershell
.\scripts\start-simulation.ps1
```

Linux 可直接设置安全的临时路由令牌并启动模拟服务：

```bash
TRANSPORT_ROUTE_TOKEN="$(node -e "console.log(require('node:crypto').randomBytes(36).toString('base64url'))")" TRANSPORT_MODE=simulation TRANSPORT_POLLING_ENABLED=false npm start
```

停止该脚本记录的本地进程：

```powershell
.\scripts\stop-local.ps1
```

## 真实账号与部署

真实模式必须先用微信扫码完成 ClawBot 授权登录，并主动设置：

```text
TRANSPORT_MODE=real
TRANSPORT_ACCOUNT_ID=<authorized-account-id>
TRANSPORT_POLLING_ENABLED=true
```

不要提交 `runtime/`、`.env`、二维码、账号文件或任何 token。Linux systemd、HTTPS tunnel 和插件模板见 [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)。ChatGPT 自动化规则见 [docs/AUTOMATION.md](docs/AUTOMATION.md)。

## 重要语义

- 新订阅只接收订阅建立之后的新事件；创建订阅不会自动 replay 已有 pending。
- 串行确认机制只管理启用该机制后新收到的事件，不会自动重放旧 pending。
- pending 仅表示 transport 尚未记录成功回复，不代表 ChatGPT 会自动收到该事件。
- 在官方文档列明支持 MCP Events 的 Work / Work Desktop Cloud / dot 中，订阅建在哪个 ChatGPT 窗口，事件就在那个窗口里处理，并延续那个窗口的上下文；我们的做法是直接在原来聊天的窗口里建订阅。普通 Chat 见上方“适用范围”。
- `send_wechat_reply` 成功与用户手机端实际看到消息是两个不同证据层级。

## License

[GNU Affero General Public License v3.0 only](LICENSE)。
