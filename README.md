# dsh-superagent-wechat-source

把**个人微信私聊**接进 [`dsh-superagent`](https://github.com/deepseek-ai/deepseek-harness) 作为来源（Source）：你在微信里发一条 `/task …`，superagent 建工单、自己执行、把结果回帖到同一个对话。

面向**独立开发者自用**：不需要组织账号、不需要企业微信/飞书。

> 状态：M0–M3 完成（传输、来源契约、登录、设置页、单测）；M4 实机端到端等待扫码验证。

## 它是什么

- **一个 superagent 来源**：消息进来后按 `/task` 前缀决定是否建单，工单执行结果通过同一条私聊回帖。
- **一个 iLink 客户端**：扫码绑定微信机器人，长轮询收消息，按 `context_token` 回消息。
- **不是聊天客户端**：实时对话请用 [`dsh-wechat`](https://github.com/pan17/dsh-wechat)，两者定位不同。

## 先决条件

1. **superagent 的 GitHub 前置**：`Setup.resolve` 会无条件解析 GitHub 部署；没有配好仓库和 `gh` 登录时工单不会执行。这是上游行为，本项目不改。
2. **一个可以绑定的微信号**：见下面「与 dsh-wechat 二选一」。

## 安装

```bash
cd /path/to/dsh-superagent-wechat-source
npm install
npm run build

# 装进 superagent profile（profile 名按你的实际配置）
dsh plugin --profile superagent add "link:$PWD"
```

然后在 profile 的 `cordis.patch.yml` 里挂载（`stateDir` 与 dsh-superagent 用同一个）：

```yaml
- insert:
    - id: dsh-superagent-wechat-source
      name: dsh-superagent-wechat-source
      config:
        stateDir: /absolute/path/to/superagent-state
```

重启 DSH，打开 **设置 → 微信任务**，用微信扫码。扫码后可能出现数字校验，按手机提示输入即可。

登录成功后在同一个设置页可以看到：

- 机器人 ID（`ilink_bot_id`）
- 扫码用户 ID（`ilink_user_id`）——把它填进 superagent 策略里的 `allowed` 名单，只有名单内的人发 `/task` 才会建单

## 使用

| 你在微信里发 | 结果 |
|---|---|
| `/task 修一下登录页的错别字` | 建工单，回一条接单确认，跑完回帖结果 |
| `/task：做事`、`/TASK 做事` | 同上（大小写、中英文冒号都接受） |
| `今天天气不错` | 不建单，只在链路里记为「源头丢弃」 |
| 群消息、图片/文件/语音 | 直接丢弃（首版只做纯文本私聊） |

回复是**接单确认 + 最终结果**两条，不做逐段流式汇报。

## 与 `dsh-wechat` 二选一

两者都通过 iLink 绑定微信机器人，但：

| 层面 | 是否冲突 |
|---|---|
| 设置页 / HTTP 路由 / 本地状态 | 不冲突（不同的 section id、路径前缀与目录） |
| **微信号绑定** | **冲突**：一个微信号只能连一个 bot 客户端 |

绑定第二个客户端通常会被平台拒绝，且目前没有自助解绑入口。**不要拿现役账号去试绑第二个 bot**——残留绑定可能反过来弄挂现有的 `dsh-wechat`。

本插件在设置页会检测 `~/.dsh-wechat/auth/token.json` 并提示冲突。请二选一，或换一个微信号。

## 已知限制

- 首版只支持**纯文本**、**一对一私聊**；没有媒体、引用回复、群聊。
- **连发上限**：连续给同一个人发满 10 条后，后续消息会被网关拒绝，要等对方先发一条消息；本插件按此计数，任何入站消息会把计数清零。
- **24 小时窗口**：超过 24 小时没互动，主动消息发不出去，需要用户先发一条。
- `context_token` 缺失或过期时回帖会失败并重试，不会丢消息（superagent 的 Outbox 按 5 秒起、翻倍到 300 秒重试）。
- 微信侧协议可能随官方升级而变化；本项目只实现本人绑定路径，不做实名/他人绑定与强制 PIN。

## 架构

```
src/
├── index.ts        插件入口：注册 kind、启动登录/轮询、挂设置页路由
├── kind.ts         SourceKind：配置、scope、policy、channel、threadContext
├── trigger.ts      iLink 消息 → Trigger（稳定 ID、/task 前缀、群消息丢弃）
├── account.ts      账号：登录、长轮询、回帖、预算、状态
├── login.ts        扫码状态机（wait/scaned/confirmed/expired/redirect/PIN/binded）
├── store.ts        token、游标、消息环、回帖计数（0600 原子写）
├── routes.ts       /agent-wechat/api/{status,qr,verify-code,relogin,logout}
├── text.ts         长回复切分
├── qr.ts           qrcode_img_content → SVG
├── ilink/          iLink HTTP 协议（发/收/生命周期）
├── vendor/         qrcode-generator（MIT，见 NOTICE.md）
└── client/         设置页客户端（settings.section）
```

本地状态在 `<stateDir>/sources/wechat/`：`auth/token.json`、`sync-buf.json`、`messages.json`（环形）、`outbound.json`。

## 开发

```bash
npm run typecheck
npm test        # node --test tests/*.test.ts
npm run build   # tsdown：lib/index.js（ESM）+ lib/client.js（DSH 模块封装）
```

## 第三方与许可

本项目以 MIT 发布。iLink 协议实现依据腾讯官方开源项目 [`Tencent/openclaw-weixin`](https://github.com/Tencent/openclaw-weixin)（MIT）的协议文档编写；二维码编码器为 qrcode-generator（Kazuhiko Arase，MIT）。详见 [NOTICE.md](NOTICE.md)。

个人微信 ClawBot 是腾讯的官方通道，但本项目是独立第三方客户端，与腾讯、DeepSeek Harness 均无隶属关系。使用风险由使用者自行承担。

## 许可

MIT（见 [LICENSE](LICENSE)）。
