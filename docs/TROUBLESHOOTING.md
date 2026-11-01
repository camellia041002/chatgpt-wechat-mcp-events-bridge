# Troubleshooting

这份指南用于判断故障发生在微信、transport、MCP 插件、ChatGPT 任务创建，还是事件执行阶段。先收集证据，再决定改哪一层；不要因为自动唤醒失败就从头重装整台服务器。

## 快速分层

| 现象 | 更可能的故障层 | 下一步 |
| --- | --- | --- |
| OAuth 失败，工具和 Events 都不可见 | 插件连接或 OAuth | 检查 MCP URL、HTTPS、OAuth 配置和插件连接 |
| 普通工具可调用，但 Events 不可见 | MCP Events 能力或事件发现 | 检查 `events` capability、`events/list` 和插件刷新结果 |
| Events 可见，但服务器没有收到 `events/subscribe`，`subscriptions=0` | ChatGPT 任务创建或插件注册状态 | 使用受支持的 Work 环境，刷新 Events，换干净的 Work 对话；必要时重建 development 插件连接 |
| 收到 `events/subscribe`，但订阅创建失败 | transport 的订阅或回调验证 | 检查 JSON-RPC 错误、参数、callback HTTPS、签名密钥和 verification 响应 |
| `subscriptions>0`，但微信消息没有形成事件 | 微信轮询或事件过滤 | 检查 real mode、polling、`channel_id`、`sender_id` 和入站计数 |
| 事件已投递，但 ChatGPT 没有调用回复工具 | ChatGPT 事件运行 | 检查任务运行记录、事件 payload、保存的 prompt 和工具权限 |
| 回复工具成功，但手机没有看到消息 | iLink 写回或客户端可见性 | 分开核对工具回执、transport 写入和手机端实际接收 |
| 同一条微信收到多次回复 | 重试身份或幂等 | 检查稳定 `webhook-id`、原始 `eventId` 和 `reply:<eventId>` |

## Events 可见，但任务服务报错且没有订阅请求

典型现象：

- OAuth、普通 MCP tools、微信登录、收消息、读 pending 和手动回复都正常；
- ChatGPT 能发现 `wechat.message.received` 及其过滤参数；
- 创建 event-triggered automation 时出现 `The task service returned an unexpected error` 或类似错误；
- 服务端没有任何新的 `events/subscribe` 请求；
- `subscriptions` 始终为 `0`；
- 没有留下重复或残留任务。

这组证据表示失败发生在 ChatGPT 调用 MCP 服务器之前。此时反复修改 Caddy、微信登录、轮询或 webhook 签名通常没有帮助，因为订阅请求尚未到达这些环节。

按以下顺序处理：

1. 使用 ChatGPT 网页端的 **Work** 对话，或桌面端的 **Work + Cloud**；不要把普通 Chat 中工具可调用当成 Events 已受支持。
2. 在插件页面刷新工具和 Events，然后确认 `wechat.message.received` 仍然可见。
3. 新开一个干净的 Work 对话，用自然语言创建事件订阅，不手写内部 automation JSON。例如：

   ```text
   订阅当前插件的 wechat.message.received 事件，channel_id=wechat。
   这是事件触发任务，不设置时间计划；收到事件后读取消息并调用微信回复工具。
   ```

4. 创建期间观察服务端。真正进入订阅阶段后，服务器应收到 `events/subscribe`，随后 `subscriptions` 应从 `0` 变为 `1`。
5. 如果 ChatGPT 仍在调用服务器前报错，可断开并重新创建 development 插件连接，重新完成 OAuth、刷新 Events，再从新的 Work 对话重试。确认新对话引用的是新插件实例，不要继续使用旧的 connector/app 记录。
6. 如果重建后仍没有任何 `events/subscribe`，保存发生时间、ChatGPT 报错、插件 Events 页面和服务端零请求的脱敏证据，向 OpenAI 反馈。服务端无法修复一个从未到达的订阅调用。

不要为了满足内部任务工具的参数校验而把空字符串时间计划当作正式解决方案。如果事件发现提示不要提供 schedule，但创建工具又强制索要 `schedule` 或 `timing_mode`，这更像任务创建路径不匹配；应先刷新或重建插件连接，而不是把事件任务改造成定时任务。

## 每小时轮询不是事件订阅

每小时调用 `get_pending_wechat_messages` 可以作为短期诊断或人工兜底，但它有明显区别：

- 最长可能等待一个完整周期；
- 它不会建立 `events/subscribe`；
- 它不能证明 MCP Events 已经接通；
- 若与正常事件任务同时启用，必须依靠严格幂等避免重复回复。

正常形态是微信新消息形成 `wechat.message.received`，ChatGPT Work 事件任务被及时触发，再使用事件绑定的 `send_wechat_reply` 写回。确认事件订阅成功后，应停用不再需要的轮询兜底。

## 收集脱敏证据

寻求帮助时，优先提供以下信息：

- ChatGPT 环境：Work 网页、Work Desktop Cloud、dot 或普通 Chat；
- 插件是否为 development mode，以及是否刚刷新或重建；
- Events 页面是否能看到 `wechat.message.received`；
- 创建任务的原始错误文字和发生时间；
- 创建前后的脱敏 `subscriptions` 数量；
- 服务端是否实际收到 `events/subscribe`；
- 是否收到 callback verification；
- 是否创建了残留任务；
- 项目测试结果，以及 real mode、polling 和微信连接的布尔状态。

不要公开 MCP URL 中的私有路由、OAuth token、callback secret、微信凭据、二维码、真实用户标识或完整日志。

## 参考

- [OpenAI MCP Events 文档](https://developers.openai.com/plugins/build/mcp-events)
- [部署说明](DEPLOYMENT.md)
- [ChatGPT Work 自动化规则](AUTOMATION.md)
- [可靠性经验](RELIABILITY_PLAYBOOK.md)
