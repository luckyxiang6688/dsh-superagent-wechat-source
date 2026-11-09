window.__ModuleLoader__.load({
	id: "dsh-superagent-wechat-source",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		// src/client/Settings.tsx
		/** Settings → 微信私聊: login state, QR, PIN, relogin/logout, usage notes. */
		const HEADERS = { "x-agent-wechat-request": "1" };
		async function getJson(path) {
			return (await fetch(path, {
				headers: HEADERS,
				cache: "no-store"
			})).json();
		}
		async function postJson(path, body) {
			return (await fetch(path, {
				method: "POST",
				headers: {
					...HEADERS,
					"Content-Type": "application/json"
				},
				body: JSON.stringify(body ?? {})
			})).json();
		}
		const PHASE_TEXT = {
			idle: "准备中…",
			waiting: "请用微信扫描二维码",
			scanned: "已扫码，请在手机上确认",
			need_verifycode: "请输入手机上显示的数字",
			confirmed: "登录成功",
			expired: "二维码已失效，请重新获取",
			error: "登录出错",
			already_bound: "该微信号已绑定到其他客户端"
		};
		const styles = {
			section: {
				display: "flex",
				flexDirection: "column",
				gap: 16,
				padding: "0 24px 24px"
			},
			card: {
				border: "1px solid rgba(128,128,128,.3)",
				borderRadius: 12,
				padding: "14px 16px",
				display: "flex",
				flexDirection: "column",
				gap: 10
			},
			row: {
				display: "flex",
				alignItems: "center",
				gap: 10,
				flexWrap: "wrap"
			},
			title: {
				fontWeight: 600,
				fontSize: 14
			},
			badge: {
				fontSize: 11,
				padding: "2px 8px",
				borderRadius: 8,
				border: "1px solid rgba(128,128,128,.4)"
			},
			ok: {
				color: "#2e7d32",
				borderColor: "#2e7d32"
			},
			warn: {
				color: "#ed6c02",
				borderColor: "#ed6c02"
			},
			bad: {
				color: "#c62828",
				borderColor: "#c62828"
			},
			hint: {
				fontSize: 12,
				opacity: .75,
				lineHeight: 1.6
			},
			mono: {
				fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
				fontSize: 12
			},
			input: {
				padding: "6px 10px",
				borderRadius: 8,
				border: "1px solid rgba(128,128,128,.4)",
				background: "transparent",
				color: "inherit",
				width: 140
			},
			button: {
				padding: "6px 14px",
				borderRadius: 8,
				border: "1px solid rgba(128,128,128,.4)",
				background: "transparent",
				color: "inherit",
				cursor: "pointer"
			},
			qr: {
				width: 220,
				height: 220,
				background: "#fff",
				padding: 8,
				borderRadius: 8,
				alignSelf: "flex-start"
			}
		};
		function Settings() {
			const [status, setStatus] = (0, react.useState)();
			const [qr, setQr] = (0, react.useState)();
			const [code, setCode] = (0, react.useState)("");
			const [notice, setNotice] = (0, react.useState)("");
			const refresh = (0, react.useCallback)(async () => {
				try {
					const next = await getJson("/agent-wechat/api/status");
					setStatus(next);
					setQr(next.loggedIn ? void 0 : await getJson("/agent-wechat/api/qr"));
				} catch {}
			}, []);
			(0, react.useEffect)(() => {
				refresh();
				const interval = setInterval(() => {
					refresh();
				}, status?.loggedIn === false ? 2e3 : 5e3);
				return () => clearInterval(interval);
			}, [refresh, status?.loggedIn]);
			const act = async (path, body) => {
				setNotice("");
				try {
					const result = await postJson(path, body);
					if (!result.ok) setNotice(result.message ?? "操作未完成");
				} catch (error) {
					setNotice(String(error).slice(0, 200));
				}
				await refresh();
			};
			const autoRetried = (0, react.useRef)(false);
			(0, react.useEffect)(() => {
				if (autoRetried.current || status?.loggedIn) return;
				const current = status?.login.phase;
				if (current !== "expired" && current !== "error") return;
				autoRetried.current = true;
				act("/agent-wechat/api/relogin");
			}, [status?.loggedIn, status?.login.phase]);
			const phase = status?.login.phase ?? "idle";
			const badge = status?.loggedIn ? {
				text: "已登录",
				style: styles.ok
			} : phase === "error" || phase === "already_bound" || phase === "expired" ? {
				text: PHASE_TEXT[phase] ?? phase,
				style: styles.bad
			} : {
				text: PHASE_TEXT[phase] ?? phase,
				style: styles.warn
			};
			return /* @__PURE__ */ (0, react.createElement)("div", { style: styles.section }, /* @__PURE__ */ (0, react.createElement)("div", { style: styles.card }, /* @__PURE__ */ (0, react.createElement)("div", { style: styles.row }, /* @__PURE__ */ (0, react.createElement)("span", { style: styles.title }, "微信私聊 · superagent 来源"), /* @__PURE__ */ (0, react.createElement)("span", { style: {
				...styles.badge,
				...badge.style
			} }, badge.text)), status?.conflict && /* @__PURE__ */ (0, react.createElement)("div", { style: {
				...styles.hint,
				color: "#c62828"
			} }, "检测到本机 dsh-wechat 已登录", status.conflict.userId ? `（${status.conflict.userId}）` : "", "。 一个微信号只能连一个 bot 客户端，请二选一：停用 dsh-wechat，或换一个微信号。", status.conflict.sameAccount ? " 当前登录的正是同一个微信号。" : ""), !status?.loggedIn && qr?.svg && qr.phase !== "expired" && qr.phase !== "error" && qr.phase !== "already_bound" && /* @__PURE__ */ (0, react.createElement)(react.Fragment, null, /* @__PURE__ */ (0, react.createElement)("div", { style: styles.hint }, "用微信扫码，把这个机器人绑定到你的个人微信。扫码后可能出现数字校验，按手机提示输入即可。"), /* @__PURE__ */ (0, react.createElement)("div", {
				style: styles.qr,
				dangerouslySetInnerHTML: { __html: qr.svg }
			})), !status?.loggedIn && qr?.phase === "need_verifycode" && /* @__PURE__ */ (0, react.createElement)("div", { style: styles.row }, /* @__PURE__ */ (0, react.createElement)("input", {
				style: styles.input,
				value: code,
				inputMode: "numeric",
				placeholder: "手机上的数字",
				onChange: (event) => setCode(event.target.value)
			}), /* @__PURE__ */ (0, react.createElement)("button", {
				style: styles.button,
				onClick: () => void act("/agent-wechat/api/verify-code", { code })
			}, "提交")), !status?.loggedIn && (qr?.phase === "expired" || qr?.phase === "error" || qr?.phase === "already_bound") && /* @__PURE__ */ (0, react.createElement)("div", { style: styles.row }, /* @__PURE__ */ (0, react.createElement)("button", {
				style: styles.button,
				onClick: () => void act("/agent-wechat/api/relogin")
			}, "重新获取二维码")), qr?.error && qr.phase !== "waiting" && /* @__PURE__ */ (0, react.createElement)("div", { style: {
				...styles.hint,
				color: "#c62828"
			} }, qr.error), status?.loggedIn && /* @__PURE__ */ (0, react.createElement)(react.Fragment, null, /* @__PURE__ */ (0, react.createElement)("div", { style: styles.hint }, "机器人 ID：", /* @__PURE__ */ (0, react.createElement)("span", { style: styles.mono }, status.botId || "—"), /* @__PURE__ */ (0, react.createElement)("br", null), "扫码用户 ID（填到策略的 allowed 里）：", /* @__PURE__ */ (0, react.createElement)("span", { style: styles.mono }, status.userId || "—"), /* @__PURE__ */ (0, react.createElement)("br", null), "长轮询：", status.polling ? "运行中" : "已停止", status.lastPollAt ? `，最近一次 ${status.lastPollAt}` : ""), status.error && /* @__PURE__ */ (0, react.createElement)("div", { style: {
				...styles.hint,
				color: "#c62828"
			} }, status.error), /* @__PURE__ */ (0, react.createElement)("div", { style: styles.row }, /* @__PURE__ */ (0, react.createElement)("button", {
				style: styles.button,
				onClick: () => void act("/agent-wechat/api/relogin")
			}, "重新登录"), /* @__PURE__ */ (0, react.createElement)("button", {
				style: styles.button,
				onClick: () => void act("/agent-wechat/api/logout")
			}, "退出登录"))), notice && /* @__PURE__ */ (0, react.createElement)("div", { style: {
				...styles.hint,
				color: "#c62828"
			} }, notice)), /* @__PURE__ */ (0, react.createElement)("div", { style: styles.card }, /* @__PURE__ */ (0, react.createElement)("span", { style: styles.title }, "怎么用"), /* @__PURE__ */ (0, react.createElement)("div", { style: styles.hint }, "1. 扫码后在微信「我 → 设置 → 插件 → 微信ClawBot」里找到这个机器人，点进去扫描连接。", /* @__PURE__ */ (0, react.createElement)("br", null), "2. 直接发消息就行，比如「修一下登录页的错别字」；主控按接单规则判断是否建单。", /* @__PURE__ */ (0, react.createElement)("br", null), "3. 建单时回一条接单确认，跑完再把结果回帖到同一个对话。", /* @__PURE__ */ (0, react.createElement)("br", null), "4. superagent 需要先配好 GitHub 仓库和 gh 登录，否则工单不会执行。", /* @__PURE__ */ (0, react.createElement)("br", null), "5. 连续给同一个人发满 10 条会被微信拦下，等你再发一条消息才恢复；本插件按此计数。")));
		}
		// src/client/index.tsx
		const name = "dsh-superagent-wechat-source";
		const inject = ["slots"];
		function apply(ctx) {
			const register = () => ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "agent-wechat",
				order: 41,
				label: "微信任务"
			}, Settings));
			if (ctx.effect) ctx.effect(register);
			else register();
		}
		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	}
});
