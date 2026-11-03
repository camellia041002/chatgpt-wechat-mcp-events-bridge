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
| 文字/图片正常，PPTX、PDF、DOCX、TXT 等文件完全没有形成事件 | transport 未处理 iLink `file_item`，或文件被类型/大小/完整性校验拒绝 | 确认版本包含 `get_wechat_file`，并检查事件的 `file_count` / `file_error_count` |
| 事件已投递，但 ChatGPT 没有调用回复工具 | ChatGPT 事件运行 | 检查任务运行记录、事件 payload、保存的 prompt 和工具权限 |
| 回复工具成功，但手机没有看到消息 | iLink 写回或客户端可见性 | 分开核对工具回执、transport 写入和手机端实际接收 |
| 同一条微信收到多次回复 | 重试身份或幂等 | 检查稳定 `webhook-id`、原始 `eventId` 和 `reply:<eventId>` |

对于瞬时网络错误、超时、HTTP 5xx 或限流，transport 会使用相同的分段 client ID 和 run ID 做有界重试。明确的 missing context、iLink prepare rejection 和确定性 HTTP 4xx 不会盲目重试；这类错误需要先修复账号、上下文或请求条件。

## 文字和图片正常，但文件消息消失

iLink 把普通文件放在 `item_list[].type=4` 的 `file_item` 中。只解析文字、语音和图片的旧版 transport 会在 ChatGPT 之前丢掉这类消息，因此服务器既不会产生 `wechat.message.received`，任务也没有机会读取文件。

更新后按以下证据判断：

- `file_count>0`：文件已下载、解密、类型校验并保存；任务应按零起始索引逐个调用 `get_wechat_file`；
- `file_error_count>0`：消息仍会形成事件，但至少一个文件因不支持、过大、下载失败、密文损坏、签名不符或 OOXML 安全校验失败而不可读；
- 两个计数都为 `0` 且只有文件：检查收到的原始 iLink 项是否确为 `type=4/file_item`，以及 transport 是否已更新并重启；
- 工具返回 `extraction_status=unavailable`：原始文件仍通过 MCP resource/audio content 返回，只是桥端没有提取文字；这不是下载失败。

不要为了“让任务继续”而猜测文件正文。附件失败应明确告知用户，并继续处理同一事件中可读的文字或其他附件。

## 事件已接受，但回复越来越慢

“最终回复了”不能证明实时链路正常。一次自然消息至少要分别记录四个时间点：

1. **入站时间**：微信消息进入 transport 并形成事件；
2. **回调接受时间**：事件 host 接受 webhook callback；
3. **写回时间**：ChatGPT 调用回复工具，transport 产生成功 write receipt；
4. **客户端完成时间**：用户在微信客户端实际看到回复。

用这四层证据判断延迟位置：

| 证据停在哪一层 | 更可能的问题 | 不应先做什么 |
| --- | --- | --- |
| 没有入站事件 | 微信登录、轮询或 transport | 不要先改 ChatGPT prompt |
| 有入站事件，但 callback 没有被接受 | tunnel、OAuth、订阅或 callback 可达性 | 不要先重建微信登录 |
| callback 已接受，但长时间没有 write receipt | ChatGPT 任务排队、运行没有启动、事件字段不可见或工具没有被调用 | 不要把 HTTP 2xx 当作回复成功，也不要反复重启 VPS |
| 回复工具很晚才开始，但开始后很快成功 | 事件 host / 长会话执行延迟 | 不要通过缩短 transport 超时伪装成根因修复 |
| write receipt 已成功，但客户端没看到 | iLink 写回后的客户端可见性或账号侧问题 | 不要重复调用回复工具制造多条消息 |

### 避免重试把慢队列变得更慢

如果 callback 已经被接受，而同一个长会话仍在排队，重复投递同一事件可能为同一条消息创建更多待运行工作。它不一定能“催快”，反而可能与后续真人消息竞争执行时间。

- 同一个逻辑事件的 `webhook-id`、正文 `eventId` 和 `data.event_id` 必须保持一致；
- 每次运行继续使用同一个 `reply:<eventId>`，不得换事件 ID 绕过去重；
- 把“callback 没到”与“callback 到了但没有 write receipt”分开处理；
- 如果环境中已接受的运行经常超过 acknowledgement timeout，可把投递次数降为一次，并让 acknowledgement timeout 覆盖正常运行时间；同时保留独立的 watchdog；
- 调整重试次数只能减少排队放大，不能保证平台执行延迟消失。

### 收件提示不是回复成功

对于经常出现长时间排队的部署，可以增加一条后端拥有、固定文案、幂等且有界的“消息已收到，正在处理”提示，但必须满足以下边界：

- 只对创建后自然到达、尚无成功 write receipt 的真人消息生效；
- 不把提示写成模型回复，不声称原消息已完成；
- 不确认、删除或清空原 pending 事件；
- 每轮卡顿最多提示一次，重启后不追发历史提示；
- 真正回复仍使用原事件绑定的回复工具和幂等键；
- watchdog 只能在有证据表明原消息仍待处理时进行独立、幂等的恢复，不能伪造原 write receipt。

排障时应同时查看任务运行记录和 transport 的脱敏状态。如果 callback 已接受、任务运行长时间没有工具调用，而 transport、tunnel 和订阅都健康，应把证据保留为平台执行延迟，而不是继续在服务器侧重复部署。

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
