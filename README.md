# dsh-superagent-wechat-source

把**个人微信私聊**接进 [`dsh-superagent`](https://github.com/deepseek-ai/deepseek-harness) 作为来源（Source）：你在微信里随口说一句要做什么，superagent 判断、建工单、自己执行、把结果回帖到同一个对话。

面向**独立开发者自用**：不需要组织账号、不需要企业微信/飞书。

> 状态：传输、来源契约、登录、设置页、单测与实机端到端均已验证（扫码绑定 → 入站 → 裁定 → 工单 → 回帖）。

## 它是什么

- **一个 superagent 来源**：每条私聊都进裁定，由接单规则决定是否建单；工单执行结果通过同一条私聊回帖。
- **一个 iLink 客户端**：扫码绑定微信机器人，长轮询收消息，按 `context_token` 回消息。
- **不是聊天客户端**：实时对话请用 [`dsh-wechat`](https://github.com/pan17/dsh-wechat)，两者定位不同。

## 先决条件

1. **superagent 的 GitHub 前置**：`Setup.resolve` 会无条件解析 GitHub 部署；没有配好仓库和 `gh` 登录时工单不会执行。这是上游行为，本项目不改。
2. **一个可以绑定的微信号**：见下面「与 dsh-wechat 二选一」。

## 安装

```bash
# 装进 superagent profile（profile 名按你的实际配置）
dsh plugin --profile superagent add dsh-superagent-wechat-source
```

需要 Node 22.19+ 或 24+。要从源码安装（想改代码时）：

```bash
cd /path/to/dsh-superagent-wechat-source
npm install
npm run build
dsh plugin --profile superagent add "link:$PWD"
```

插件自带的 `cordis.patch.yml` 会在 profile 的 `bundles` 里出现时自动挂载，不需要手写 insert。**状态目录默认 `~/.dsh-superagent-wechat`**；想跟 dsh-superagent 的 state 放在一起，就在 profile 的 `cordis.patch.yml` 里覆盖：

```yaml
- id: dsh-superagent-wechat-source
  config:
    stateDir: /absolute/path/to/superagent-state
```

重启 DSH，打开 **设置 → 微信任务**，在微信「我 → 设置 → 插件 → 微信ClawBot」里点进去用「扫一扫」扫码连接。扫码后可能出现数字校验，按手机提示输入即可。

登录成功后在同一个设置页可以看到：

- 机器人 ID（`ilink_bot_id`）
- 扫码用户 ID（`ilink_user_id`）——把它填进 superagent 策略里的 `allowed` 名单，只有名单内的人的私聊会被裁定，名单外的一律忽略

## 使用

**不需要任何前缀**——私聊这个机器人本身就算「点名了它」，每条消息都会交给主控裁定，由接单规则判断是不是工作。`/task` 仍然可用（写了会被剥掉），只是不再必需。

| 你在微信里发 | 结果 |
|---|---|
| `修一下登录页的错别字` | 裁定通过 → 建工单，回接单确认，跑完回帖结果 |
| `今天天气不错` | 进裁定后被忽略，链路里记为「经主控裁定 · 忽略」 |
| `/task 修一下登录页的错别字` | 同上（前缀被剥掉） |
| 群消息、图片/文件/语音 | 直接丢弃（首版只做纯文本私聊） |

回复是**接单确认 + 最终结果**两条，不做逐段流式汇报。

> 代价：每条私聊都会花一次裁定（你配的评估模型），并且「接单模式（关闭/仅观察/自动接单）」管不了私聊——那是给「未点名」的候选用的。要临时静音，关掉这个来源或暂停编排。

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
- **每条私聊都会触发一次裁定**（一次评估模型调用）。闲聊会被判成忽略、不建单，但调用照样发生。
- **接单模式管不了私聊**：名单内 + 私聊 = 直接判 explicit，不走「关闭/仅观察/自动接单」。静音请关掉来源或暂停编排。
- **连发上限**：连续给同一个人发满 10 条后，后续消息会被网关拒绝，要等对方先发一条消息；本插件按此计数，任何入站消息会把计数清零。
- **24 小时窗口**：超过 24 小时没互动，主动消息发不出去，需要用户先发一条。
- `context_token` 缺失或过期时回帖会失败并重试，不会丢消息（superagent 的 Outbox 按 5 秒起、翻倍到 300 秒重试）。
- 微信侧协议可能随官方升级而变化；本项目只实现本人绑定路径，不做实名/他人绑定与强制 PIN。

## 架构

```
src/
├── index.ts        插件入口：注册 kind、启动登录/轮询、挂设置页路由
├── kind.ts         SourceKind：配置、scope、policy、channel、threadContext
├── contract.ts     Source 契约的结构类型（不 import @deepseek-ai/*）
├── trigger.ts      iLink 消息 → Trigger（稳定 ID、剥掉可选 /task、群消息丢弃）
├── account.ts      账号：登录、长轮询、回帖、预算、状态
├── runtime.ts      账号单例的存放与读取
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
