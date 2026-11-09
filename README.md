# dsh-superagent-wechat-source

把**个人微信私聊**接进 [`dsh-superagent`](https://github.com/deepseek-ai/deepseek-harness) 作为来源（Source）：你在微信里丢一句话，superagent 建工单、自己执行、把结果回帖到同一个对话。

面向**独立开发者自用**：不需要组织账号、不需要企业微信/飞书，也不要求你先把 agent 的 GitHub 机器人配齐。

> 状态：**设计阶段**。仓库里目前只有范围说明、许可证与第三方声明，没有可运行代码。

## 范围

| 做 | 不做 |
|---|---|
| 一对一私聊（DM）作为需求入口 | 群聊、群成员名单、@ 事件 |
| 单发送者（你自己的 wxid）自动放行 | 多用户准入策略、成员同步 |
| 任务建单 → 执行 → 回帖到同一 DM | 实时对话（那是 `dsh-wechat` 的职责） |
| 长任务跨 24 小时窗口时的待发队列 | 个人微信以外的通道 |

**明确不做群聊。** 个人号通道不适合承载「旁观别人的群」这种能力，产品上也不做这个定位。

## 与 `dsh-wechat` 的关系

`dsh-wechat` 解决「我在微信里跟我的 agent 聊天」——它是 DSH 的**第二客户端**，面向会话。
本项目解决「我把任务丢给 agent，它自己跑完回我」——它是 superagent 的**来源**，面向工单。

两者共用同一条 iLink 个人号通道，但不在同一层，也不共享代码接口（见下）。

## 第三方与许可

本项目以 MIT 发布。设计上参考、可能移植以下 MIT 项目，**保留其版权声明与出处注释**（详见 [NOTICE.md](NOTICE.md)）：

- [`dsh-wechat`](https://github.com/pan17/dsh-wechat) — 个人微信 iLink 通道在 DSH 侧的落地方式
- [`wechat-opencode`](https://github.com/pan17/wechat-opencode) — `dsh-wechat` 的上游，iLink 收发与适配层的原始实现
- [`dsh-superagent`](https://github.com/deepseek-ai/deepseek-harness) — Source 契约与宿主接口

个人微信没有官方 bot API，本项目与腾讯、DeepSeek Harness 均无隶属关系，纯属个人学习用途；使用风险（含账号限制）由使用者自行承担。

## 许可

MIT（见 [LICENSE](LICENSE)）。
