# 第三方声明

本项目以 MIT 许可发布。以下作品被参考或（部分）移植，版权归其作者所有，
其许可条款与本项目的 MIT 许可并存。移植的文件保留原文件头的出处注释。

---

## dsh-wechat

- 仓库：https://github.com/pan17/dsh-wechat
- 许可：MIT
- 版权：Copyright (c) 2026 dsh-wechat contributors
- 用途：参考其在 DSH 插件内接入个人微信 iLink 通道的方式（登录、消息收发、状态持久化、限速与待发队列的处理思路）。

## wechat-opencode

- 仓库：https://github.com/pan17/wechat-opencode
- 许可：MIT
- 用途：iLink 客户端与适配层的原始实现（`dsh-wechat` 的 `src/weixin/`、`src/adapter/` 即移植自该项目，原始来源标注为 `@tencent-weixin/openclaw-weixin`）。

## dsh-superagent（DeepSeek Harness）

- 仓库：https://github.com/deepseek-ai/deepseek-harness
- 许可：MIT
- 版权：Copyright (c) 2026 DeepSeek Harness Team
- 用途：宿主与本项目实现的 Source 契约；本项目不复制其代码，只调用其公开接口。

---

MIT 许可要求保留上述版权声明与许可文本。若某文件包含来自第三方的代码，
该文件头部的出处注释优先于本节的一般性说明。
