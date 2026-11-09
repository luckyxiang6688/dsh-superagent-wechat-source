# 第三方声明

本项目以 MIT 许可发布。以下作品被参考、引用或（部分）包含，版权归其作者所有，
其许可条款与本项目的 MIT 许可并存。

---

## Tencent/openclaw-weixin（微信 iLink / ClawBot 官方通道）

- 仓库：https://github.com/Tencent/openclaw-weixin
- 许可：MIT — `Copyright (C) 2026 Tencent. All rights reserved.`
- 用途：`src/ilink/` 与 `src/login.ts` 依据其 `docs/protocol_zh_CN.md` 与 `src/` 的协议实现编写，
  只取纯文本私聊所需的最小集合（登录状态机、长轮询、发消息、生命周期通知）。
- 说明：本项目是独立第三方客户端，不是腾讯官方发行物。

## qrcode-generator

- 作者：Kazuhiko Arase
- 许可：MIT
- 文件：`src/vendor/qrcode.mjs`（原样保留了上游版权头）
- 用途：把 iLink 返回的 `qrcode_img_content` 网页 URL 编码成 SVG 二维码；
  该值不是图片，`<img src>` 无法显示。

## dsh-wechat

- 仓库：https://github.com/pan17/dsh-wechat
- 许可：MIT — `Copyright (c) 2026 dsh-wechat contributors`
- 用途：参考其 DSH 侧的接入方式（`settings.section` 设置页、`webServer` 路由、
  免 `@deepseek-ai/*` 运行时的结构化契约、二维码编码做法）。本项目未复制其源码。

## pan17/wechat-bridge-opencode（原 wechat-opencode）

- 仓库：https://github.com/pan17/wechat-bridge-opencode
- 许可：MIT
- 用途：`dsh-wechat` 的上游，仅作背景参考；本项目未直接使用其代码。

## dsh-superagent（DeepSeek Harness）

- 仓库：https://github.com/deepseek-ai/deepseek-harness
- 许可：MIT — `Copyright (c) 2026 DeepSeek Harness Team`
- 用途：宿主与本项目实现的 Source 契约；本项目不复制其代码，只调用公开的 `orchestrator` 服务。

---

MIT 许可要求保留上述版权声明与许可文本。若某文件包含来自第三方的代码，
该文件头部的出处注释优先于本节的一般性说明。
