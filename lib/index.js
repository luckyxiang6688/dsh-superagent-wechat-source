import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { z } from "zod";
/** Fixed host for QR requests, as documented upstream. */
const QR_BASE_URL = "https://ilinkai.weixin.qq.com";
/**
* `channel_version` is parsed as major.minor.patch and must be the official
* generation (3.x). Our own marker lives in the suffix.
*/
const CHANNEL_VERSION = "3.0.0/dsh-superagent-wechat-0.1.0";
/** `iLink-App-ClientVersion`: 0x00MMNNPP of the leading official version. */
function clientVersionOf(version) {
	const [major = 0, minor = 0, patch = 0] = version.split("/")[0].split(".").map((part) => Number.parseInt(part, 10));
	return (major & 255) << 16 | (minor & 255) << 8 | patch & 255;
}
const ILINK_APP_CLIENT_VERSION = clientVersionOf(CHANNEL_VERSION);
const DEFAULT_API_TIMEOUT_MS = 15e3;
function buildCommonHeaders() {
	return {
		"iLink-App-Id": "bot",
		"iLink-App-ClientVersion": String(ILINK_APP_CLIENT_VERSION)
	};
}
/** X-WECHAT-UIN: a random uint32 rendered as a decimal string, then base64. */
function randomWechatUin() {
	return Buffer.from(String(randomBytes(4).readUInt32BE(0)), "utf-8").toString("base64");
}
function buildPostHeaders(token) {
	const headers = {
		"Content-Type": "application/json",
		AuthorizationType: "ilink_bot_token",
		"X-WECHAT-UIN": randomWechatUin(),
		...buildCommonHeaders()
	};
	if (token?.trim()) headers.Authorization = `Bearer ${token.trim()}`;
	return headers;
}
async function request(method, url, init) {
	const fetchImpl = init.fetchImpl ?? fetch;
	const timeout = AbortSignal.timeout(init.timeoutMs);
	const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
	const response = await fetchImpl(url, {
		method,
		headers: init.headers,
		body: init.body,
		signal
	});
	const text = await response.text();
	if (!response.ok) throw new Error(`${method} ${url} -> HTTP ${response.status}: ${text.slice(0, 300)}`);
	return text;
}
const join$1 = (baseUrl, endpoint) => `${baseUrl.replace(/\/+$/, "")}/${endpoint.replace(/^\/+/, "")}`;
/**
* JSON.parse, but uint64 identifiers that arrive as bare numbers are quoted
* first so `message_id` does not lose precision.
*/
function parseLossless(raw) {
	const quoted = raw.replace(/("(?:message_id|msg_id|svr_id)"\s*:\s*)(-?\d{16,})/g, "$1\"$2\"");
	return JSON.parse(quoted);
}
/** `POST ilink/bot/get_bot_qrcode?bot_type=3` — a new bind QR for the self-bind path. */
async function getBotQrcode(options) {
	const botType = options.botType ?? "3";
	const raw = await request("POST", join$1(options.baseUrl, `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`), {
		headers: buildPostHeaders(),
		body: JSON.stringify({ local_token_list: options.localTokenList ?? [] }),
		timeoutMs: options.timeoutMs ?? DEFAULT_API_TIMEOUT_MS,
		signal: options.signal,
		fetchImpl: options.fetchImpl
	});
	return JSON.parse(raw);
}
/** `GET ilink/bot/get_qrcode_status` — a 35-second long poll of the bind QR state. */
async function getQrcodeStatus(options) {
	let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(options.qrcode)}`;
	if (options.verifyCode) endpoint += `&verify_code=${encodeURIComponent(options.verifyCode)}`;
	try {
		const raw = await request("GET", join$1(options.baseUrl, endpoint), {
			headers: buildCommonHeaders(),
			timeoutMs: options.timeoutMs ?? 35e3,
			signal: options.signal,
			fetchImpl: options.fetchImpl
		});
		return JSON.parse(raw);
	} catch (error) {
		if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) return { status: "wait" };
		if (String(error).includes("HTTP 5")) return { status: "wait" };
		throw error;
	}
}
function baseInfoOf(options) {
	return options.baseInfo ?? {
		channel_version: "3.0.0/dsh-superagent-wechat-0.1.0",
		bot_agent: "DSHSuperagentWechat/0.1.0"
	};
}
/** `POST ilink/bot/getupdates` — long poll. Returns an empty page on timeout. */
async function getUpdates(options) {
	const timeoutMs = options.timeoutMs ?? 35e3;
	try {
		return parseLossless(await request("POST", join$1(options.baseUrl, "ilink/bot/getupdates"), {
			headers: buildPostHeaders(options.token),
			body: JSON.stringify({
				get_updates_buf: options.getUpdatesBuf ?? "",
				base_info: baseInfoOf(options)
			}),
			timeoutMs,
			signal: options.signal,
			fetchImpl: options.fetchImpl
		}));
	} catch (error) {
		if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) return {
			ret: 0,
			msgs: [],
			get_updates_buf: options.getUpdatesBuf
		};
		throw error;
	}
}
/** `POST ilink/bot/sendmessage` — one text message. Throws on a non-zero `ret`. */
async function sendMessage(options) {
	const response = parseLossless(await request("POST", join$1(options.baseUrl, "ilink/bot/sendmessage"), {
		headers: buildPostHeaders(options.token),
		body: JSON.stringify({
			...options.body,
			base_info: baseInfoOf(options)
		}),
		timeoutMs: options.timeoutMs ?? DEFAULT_API_TIMEOUT_MS,
		signal: options.signal,
		fetchImpl: options.fetchImpl
	}));
	if (response.ret && response.ret !== 0) throw new Error(`sendMessage ret=${response.ret} errmsg=${response.errmsg ?? "(none)"}`);
	return response;
}
async function lifecycle(options, verb) {
	await request("POST", join$1(options.baseUrl, `ilink/bot/msg/${verb}`), {
		headers: buildPostHeaders(options.token),
		body: JSON.stringify({ base_info: baseInfoOf(options) }),
		timeoutMs: options.timeoutMs ?? 1e4,
		signal: options.signal,
		fetchImpl: options.fetchImpl
	});
}
const notifyStart = (options) => lifecycle(options, "notifystart");
const notifyStop = (options) => lifecycle(options, "notifystop");
/** Builds the outbound text message body shared by every reply. */
function textMessage(input) {
	return { msg: {
		from_user_id: "",
		to_user_id: input.to,
		client_id: input.clientId,
		message_type: 2,
		message_state: 2,
		item_list: input.text ? [{
			type: 1,
			text_item: { text: input.text }
		}] : void 0,
		...input.contextToken ? { context_token: input.contextToken } : {}
	} };
}
// src/login.ts
/**
* QR login state machine.
*
* States and transitions follow Tencent/openclaw-weixin's protocol docs:
* wait / scaned / confirmed / expired / scaned_but_redirect /
* need_verifycode / verify_code_blocked / binded_redirect.
* Only the self-bind path is implemented (no `bot_spam_ticket`, no real-name CGI).
*/
const LOGIN_TIMEOUT_MS = 3e5;
const MAX_QR_REFRESH = 3;
const CODE_WAIT_MS = 25e3;
const wait = (ms) => new Promise((resolve) => {
	setTimeout(resolve, ms);
});
var LoginSession = class {
	controller;
	running;
	current = { phase: "idle" };
	pendingCode;
	codeWaiter;
	options;
	constructor(options) {
		this.options = options;
	}
	state() {
		return { ...this.current };
	}
	/** Starts the flow unless it is already running. `restart()` stops first. */
	start() {
		if (this.running) return;
		this.controller = new AbortController();
		this.running = this.loop(this.controller.signal).finally(() => {
			this.running = void 0;
			this.controller = void 0;
		});
	}
	stop() {
		this.controller?.abort();
		this.codeWaiter?.();
	}
	/** Supplies the phone PIN; returns false when the flow is not asking for one. */
	submitCode(code) {
		if (this.current.phase !== "need_verifycode") return false;
		this.pendingCode = code.trim();
		const waiter = this.codeWaiter;
		this.codeWaiter = void 0;
		waiter?.();
		return true;
	}
	async waitForCode(signal) {
		if (this.pendingCode || signal.aborted) return;
		await new Promise((resolve) => {
			const timer = setTimeout(() => {
				this.codeWaiter = void 0;
				resolve();
			}, CODE_WAIT_MS);
			this.codeWaiter = () => {
				clearTimeout(timer);
				this.codeWaiter = void 0;
				resolve();
			};
			signal.addEventListener("abort", () => {
				clearTimeout(timer);
				resolve();
			}, { once: true });
		});
	}
	async loop(signal) {
		const startedAt = /* @__PURE__ */ new Date();
		const deadline = startedAt.getTime() + LOGIN_TIMEOUT_MS;
		let refreshCount = 0;
		let baseUrl = QR_BASE_URL;
		while (!signal.aborted && Date.now() < deadline) {
			let qrcode;
			try {
				const response = await getBotQrcode({
					baseUrl: QR_BASE_URL,
					localTokenList: this.options.localTokenList(),
					fetchImpl: this.options.fetchImpl,
					signal
				});
				qrcode = response.qrcode;
				baseUrl = QR_BASE_URL;
				this.current = {
					phase: "waiting",
					qrUrl: response.qrcode_img_content,
					startedAt: startedAt.toISOString(),
					expiresAt: new Date(deadline).toISOString()
				};
			} catch (error) {
				if (signal.aborted) return;
				this.current = {
					phase: "error",
					error: `获取二维码失败：${String(error).slice(0, 300)}`,
					startedAt: startedAt.toISOString()
				};
				return;
			}
			let refresh = false;
			while (!signal.aborted && Date.now() < deadline) {
				if (this.current.phase === "need_verifycode") await this.waitForCode(signal);
				if (signal.aborted) return;
				const verifyCode = this.pendingCode;
				let status;
				try {
					status = await getQrcodeStatus({
						baseUrl,
						qrcode,
						...verifyCode ? { verifyCode } : {},
						fetchImpl: this.options.fetchImpl,
						signal
					});
				} catch (error) {
					if (signal.aborted) return;
					this.current = {
						...this.current,
						phase: "error",
						error: `查询扫码状态失败：${String(error).slice(0, 300)}`
					};
					return;
				}
				if (signal.aborted) return;
				const value = String(status.status ?? "");
				if (value.includes("need_verifycode")) {
					this.pendingCode = void 0;
					this.current = {
						...this.current,
						phase: "need_verifycode"
					};
					continue;
				}
				if (value === "scaned") {
					if (verifyCode) this.pendingCode = void 0;
					this.current = {
						...this.current,
						phase: "scanned"
					};
					continue;
				}
				if (value === "confirmed") {
					if (typeof status.bot_token !== "string" || !status.bot_token) {
						this.current = {
							...this.current,
							phase: "error",
							error: "登录已确认，但服务端没有返回 bot_token"
						};
						return;
					}
					const token = {
						token: status.bot_token,
						baseUrl: status.baseurl || baseUrl,
						accountId: String(status.ilink_bot_id ?? ""),
						userId: String(status.ilink_user_id ?? ""),
						savedAt: (/* @__PURE__ */ new Date()).toISOString()
					};
					this.current = { phase: "confirmed" };
					this.options.onConfirmed(token);
					return;
				}
				if (value === "scaned_but_redirect") {
					if (status.redirect_host) baseUrl = `https://${status.redirect_host}`;
					continue;
				}
				if (value === "binded_redirect") {
					this.current = {
						...this.current,
						phase: "already_bound",
						error: "这个微信号已经绑定到另一个客户端；请先停用那边，或换一个微信号"
					};
					return;
				}
				if (value === "expired" || value === "verify_code_blocked") {
					refreshCount += 1;
					this.pendingCode = void 0;
					if (refreshCount > MAX_QR_REFRESH) {
						this.current = {
							...this.current,
							phase: "expired",
							error: "二维码多次失效，请稍后再试"
						};
						return;
					}
					refresh = true;
					break;
				}
			}
			if (!refresh) {
				if (!signal.aborted) this.current = {
					...this.current,
					phase: "expired",
					error: "登录超时，请重新获取二维码"
				};
				return;
			}
			if (Date.now() >= deadline) {
				this.current = {
					...this.current,
					phase: "expired",
					error: "登录超时，请重新获取二维码"
				};
				return;
			}
			await wait(500);
		}
		if (!signal.aborted) this.current = {
			phase: "expired",
			error: "登录超时，请重新获取二维码"
		};
	}
};
// src/store.ts
/** Durable account state: bot token, poll cursor, message ring, outbound counters. */
const privateDir = (path) => {
	mkdirSync(path, {
		recursive: true,
		mode: 448
	});
};
/** Atomic 0600 write; the temp file never holds a token in a world-readable place. */
function writePrivate(path, value) {
	privateDir(dirname(path));
	const temp = `${path}.tmp`;
	writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 384 });
	chmodSync(temp, 384);
	renameSync(temp, path);
}
function readJson$1(path) {
	if (!existsSync(path)) return void 0;
	try {
		return JSON.parse(readFileSync(path, "utf-8"));
	} catch {
		return;
	}
}
var Store = class {
	root;
	tokenData;
	buffer = "";
	messages = [];
	outbound = {};
	historyLimit;
	constructor(stateDir, historyLimit) {
		this.historyLimit = historyLimit;
		this.root = join(stateDir, "sources", "wechat");
		privateDir(this.root);
		const stored = readJson$1(join(this.root, "auth", "token.json"));
		this.tokenData = stored && typeof stored.token === "string" && stored.token ? stored : void 0;
		this.buffer = readJson$1(join(this.root, "sync-buf.json"))?.buffer ?? "";
		this.messages = readJson$1(join(this.root, "messages.json")) ?? [];
		this.outbound = readJson$1(join(this.root, "outbound.json")) ?? {};
	}
	get token() {
		return this.tokenData;
	}
	saveToken(token) {
		this.tokenData = token;
		writePrivate(join(this.root, "auth", "token.json"), token);
	}
	clearToken() {
		this.tokenData = void 0;
		writePrivate(join(this.root, "auth", "token.json"), {});
	}
	get cursor() {
		return this.buffer;
	}
	saveCursor(buffer) {
		if (buffer === this.buffer) return;
		this.buffer = buffer;
		writePrivate(join(this.root, "sync-buf.json"), { buffer });
	}
	/** Appends one inbound message, keeping the newest `historyLimit` entries. */
	appendMessage(message) {
		this.messages = [...this.messages, message].slice(-this.historyLimit);
		writePrivate(join(this.root, "messages.json"), this.messages);
	}
	history(user, limit = this.historyLimit) {
		return this.messages.filter((message) => message.user === user).slice(-limit);
	}
	outboundOf(user) {
		return this.outbound[user] ?? { count: 0 };
	}
	/** A user message resets the consecutive-send counter and refreshes the reply token. */
	noteInbound(user, contextToken) {
		const previous = this.outbound[user];
		this.outbound[user] = {
			count: 0,
			...contextToken ? { contextToken } : previous?.contextToken ? { contextToken: previous.contextToken } : {}
		};
		writePrivate(join(this.root, "outbound.json"), this.outbound);
	}
	noteOutbound(user) {
		const previous = this.outboundOf(user);
		this.outbound[user] = {
			...previous,
			count: previous.count + 1
		};
		writePrivate(join(this.root, "outbound.json"), this.outbound);
	}
};
// src/text.ts
/** Splits one reply into WeChat-sized segments (code points, natural breaks). */
const codePoints = (text) => Array.from(text);
function splitText(text, limit = 4e3) {
	const max = Number.isFinite(limit) && limit >= 1 ? Math.floor(limit) : 1;
	if (codePoints(text).length <= max) return [text];
	const pieces = [];
	let remaining = text;
	while (remaining) {
		const points = codePoints(remaining);
		if (points.length <= max) {
			pieces.push(remaining);
			break;
		}
		const hard = points.slice(0, max).join("");
		const minimum = Math.ceil(hard.length * .55);
		let cut = hard.length;
		for (const needle of [
			"\n\n",
			"\n",
			" "
		]) {
			const index = hard.lastIndexOf(needle);
			if (index > 0 && index >= minimum) {
				cut = index + needle.length;
				break;
			}
		}
		const piece = remaining.slice(0, cut).replace(/\s+$/, "");
		if (piece) pieces.push(piece);
		remaining = remaining.slice(cut).replace(/^\s+/, "");
	}
	return pieces;
}
// src/ilink/types.ts
const MessageItemType = {
	NONE: 0,
	TEXT: 1
};
// src/trigger.ts
const SOURCE$1 = "wechat";
/**
* `/task` is optional. A DM to the bot is already addressed to it (see the
* Source contract's `addressed: 'direct'`), so every message is a candidate and
* the Policy decides whether it is work. The prefix is stripped when present.
*/
const TASK_PREFIX = /^\/task(?:[\s：:，,]+|$)/i;
const threadOf = (user) => `${SOURCE$1}:${user}`;
/** The first text item of a message, or undefined for media-only messages. */
function textOf(message) {
	for (const item of message.item_list ?? []) if (item.type === MessageItemType.TEXT && item.text_item?.text != null) return String(item.text_item.text);
}
/** Stable per-message key: the server message id, else the client id, else the sequence. */
function messageKey(message) {
	const candidate = message.message_id ?? message.client_id ?? (message.seq !== void 0 ? String(message.seq) : void 0);
	if (candidate && candidate !== "0") return candidate;
	if (message.create_time_ms !== void 0) return `${message.create_time_ms}-${message.seq ?? 0}`;
}
/**
* Returns undefined for messages this Source must not ingest: group messages,
* the bot's own output, messages without a sender, and media-only messages.
*/
function toTrigger(message, now = Date.now()) {
	if (message.group_id) return void 0;
	if (!message.from_user_id) return void 0;
	if (message.message_type === 2) return void 0;
	const key = messageKey(message);
	if (!key) return void 0;
	const text = textOf(message);
	if (text === void 0) return void 0;
	const match = TASK_PREFIX.exec(text);
	const body = match ? text.slice(match[0].length).trim() : text;
	const user = message.from_user_id;
	const thread = threadOf(user);
	const atMs = message.create_time_ms ?? now;
	return {
		id: `${SOURCE$1}:${user}:${key}`,
		source: SOURCE$1,
		threads: [{
			source: SOURCE$1,
			id: thread
		}],
		actor: {
			source: SOURCE$1,
			id: user
		},
		human: message.message_type === 1,
		addressed: "direct",
		at: new Date(atMs).toISOString(),
		text: body,
		channel: {
			source: SOURCE$1,
			thread,
			address: { user }
		},
		meta: {
			messageId: message.message_id ?? key,
			...message.client_id ? { clientId: message.client_id } : {},
			atMs,
			prefixMatched: match !== null
		}
	};
}
// src/account.ts
/** Owns the bot account: QR login, long-poll receive, outbound send, durable state. */
/**
* Reads whether dsh-wechat already logged this machine in. One WeChat account
* can be bound to only one bot client, so an existing dsh-wechat login means a
* second binding will very likely be refused.
*/
function dshWechatAccount(home = homedir()) {
	const path = join(home, ".dsh-wechat", "auth", "token.json");
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8"));
		return {
			path,
			...typeof parsed.userId === "string" && parsed.userId ? { userId: parsed.userId } : {}
		};
	} catch {
		return;
	}
}
const sleep = (ms, signal) => new Promise((resolve) => {
	const timer = setTimeout(done, ms);
	function done() {
		clearTimeout(timer);
		signal.removeEventListener("abort", done);
		resolve();
	}
	signal.addEventListener("abort", done, { once: true });
});
var Account = class {
	store;
	login;
	monitor;
	polling = false;
	lastPollAt;
	error;
	deps;
	constructor(deps) {
		this.deps = deps;
		this.store = new Store(deps.stateDir, deps.historyLimit);
		this.login = new LoginSession({
			localTokenList: () => this.store.token ? [this.store.token.token] : [],
			onConfirmed: (token) => {
				this.store.saveToken(token);
				this.error = void 0;
				this.startMonitor();
			},
			...deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {},
			...deps.log ? { log: deps.log } : {}
		});
	}
	start() {
		if (this.store.token) this.startMonitor();
		else {
			this.login.start();
			this.deps.report("paused", "等待扫码登录");
		}
	}
	stop() {
		this.login.stop();
		this.monitor?.abort();
	}
	status() {
		const token = this.store.token;
		const bridge = dshWechatAccount();
		return {
			loggedIn: !!token,
			...token ? {
				botId: token.accountId,
				userId: token.userId
			} : {},
			polling: this.polling,
			...this.lastPollAt ? { lastPollAt: this.lastPollAt } : {},
			...this.error ? { error: this.error } : {},
			login: this.login.state(),
			...bridge ? { conflict: {
				path: bridge.path,
				...bridge.userId ? { userId: bridge.userId } : {},
				sameAccount: !!token && bridge.userId === token.userId
			} } : {}
		};
	}
	/** Returns a login QR, starting the flow on first request. */
	qr() {
		if (!this.store.token) {
			const phase = this.login.state().phase;
			if (phase === "idle" || phase === "expired" || phase === "error" || phase === "already_bound") this.login.start();
		}
		return this.login.state();
	}
	submitVerifyCode(code) {
		return this.login.submitCode(code);
	}
	relogin() {
		this.monitor?.abort();
		this.monitor = void 0;
		this.polling = false;
		this.store.clearToken();
		this.login.stop();
		this.login.start();
	}
	logout() {
		this.monitor?.abort();
		this.monitor = void 0;
		this.polling = false;
		this.store.clearToken();
		this.login.stop();
		this.deps.report("paused", "已退出登录");
	}
	history(user, limit) {
		return this.store.history(user, limit);
	}
	/** Sends one text reply; throws when a later retry may succeed. */
	async sendText(user, text, messageId) {
		const token = this.store.token;
		if (!token) throw new Error("微信未登录");
		const outbound = this.store.outboundOf(user);
		if (!outbound.contextToken) throw new Error("缺少 context_token：需要该用户先发一条消息");
		const chunks = splitText(text);
		if (!chunks.length) throw new Error("回复内容为空");
		if (outbound.count + chunks.length > 10) throw new Error("微信连发上限（10 条）将超出：等该用户发一条消息后再发送");
		for (const [index, chunk] of chunks.entries()) {
			const clientId = `dsh-${createHash("sha1").update(`${messageId}#${index}`).digest("hex").slice(0, 32)}`;
			await sendMessage({
				baseUrl: token.baseUrl,
				token: token.token,
				body: textMessage({
					to: user,
					text: chunk,
					clientId,
					contextToken: outbound.contextToken
				}),
				...this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {}
			});
			this.store.noteOutbound(user);
		}
		return "sent";
	}
	startMonitor() {
		const token = this.store.token;
		if (!token || this.monitor) return;
		const controller = new AbortController();
		this.monitor = controller;
		this.polling = true;
		this.deps.report("starting", "正在接收微信消息");
		this.monitorLoop(token, controller.signal).finally(() => {
			this.polling = false;
			if (this.monitor === controller) this.monitor = void 0;
		});
	}
	async monitorLoop(token, signal) {
		const api = () => ({
			baseUrl: token.baseUrl,
			token: token.token,
			signal,
			...this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {}
		});
		try {
			await notifyStart(api());
		} catch {}
		let failures = 0;
		let backoff = 5e3;
		try {
			while (!signal.aborted) try {
				const response = await getUpdates({
					...api(),
					getUpdatesBuf: this.store.cursor
				});
				if (signal.aborted) return;
				if (response.errcode === -14 || response.ret === -14) {
					this.deps.report("paused", "会话已失效：暂停一小时后再试");
					await sleep(36e5, signal);
					try {
						await notifyStart(api());
					} catch {}
					continue;
				}
				if (response.ret && response.ret !== 0) throw new Error(`getUpdates ret=${response.ret} errmsg=${response.errmsg ?? ""}`);
				failures = 0;
				backoff = 5e3;
				this.lastPollAt = (/* @__PURE__ */ new Date()).toISOString();
				if (response.get_updates_buf) this.store.saveCursor(response.get_updates_buf);
				for (const message of response.msgs ?? []) this.ingest(message);
				this.deps.report("ready", "正在接收微信消息");
			} catch (error) {
				if (signal.aborted) return;
				failures += 1;
				this.error = String(error).slice(0, 300);
				this.deps.report("error", `轮询失败 ${failures} 次：${this.error}`);
				await sleep(backoff, signal);
				backoff = Math.min(backoff * 2, 6e4);
			}
		} finally {
			try {
				await notifyStop(api());
			} catch {}
		}
	}
	/** Records one inbound message and hands its Trigger to the host. */
	ingest(message) {
		if (message.group_id || !message.from_user_id) return;
		this.store.noteInbound(message.from_user_id, message.context_token);
		const text = textOf(message);
		if (text === void 0) return;
		const trigger = toTrigger(message);
		if (!trigger) return;
		this.store.appendMessage({
			id: `${message.from_user_id}:${String(message.message_id ?? message.client_id ?? message.seq ?? "")}`,
			messageId: String(message.message_id ?? ""),
			user: message.from_user_id,
			at: trigger.at,
			text
		});
		try {
			this.deps.receive(trigger);
		} catch (error) {
			this.deps.log?.(`receive failed: ${String(error).slice(0, 200)}`);
		}
	}
};
// src/runtime.ts
let current;
const setAccount = (account) => {
	current = account;
};
const currentAccount = () => current;
// src/kind.ts
/** The `wechat` SourceKind: config, listening scope, policy, channel, thread context. */
const SOURCE = "wechat";
const WechatConfigSchema = z.object({
	/** How many inbound messages the local ring keeps for thread context. */
	historyLimit: z.number().int().min(20).max(1e3).default(200),
	/** Page size when an assessment reads the thread. */
	readPageSize: z.number().int().min(5).max(100).default(20)
}).strict();
const localized = (zh, en) => ({
	zh,
	en
});
const wechatKind = {
	kind: SOURCE,
	title: localized("微信私聊", "WeChat DM"),
	description: localized("接收你发给自己微信机器人的私聊；每条私聊都交给裁定判断是否建单，结果回帖到同一个对话。", "Receives DMs to your own WeChat bot; every DM is assessed for whether it opens a ticket, and results are posted back to the same chat."),
	schema: WechatConfigSchema,
	fields: [{
		key: "historyLimit",
		type: "number",
		advanced: true,
		min: 20,
		max: 1e3,
		label: localized("本地保留的消息数", "Messages kept locally"),
		hint: localized("智能体读取线程上下文时最多回溯的条数。", "How far back agents can read this thread.")
	}, {
		key: "readPageSize",
		type: "number",
		advanced: true,
		min: 5,
		max: 100,
		label: localized("每页消息数", "Messages per page"),
		hint: localized("智能体读取线程时每页返回的条数。", "Messages per page when agents read the thread.")
	}],
	health: ["wechat"],
	/**
	* Every DM to the bot is listened to. The Trigger carries
	* `addressed: 'direct'`, so a listed sender's message is admitted as an
	* explicit request and the assessor decides whether it is work.
	*/
	scope(_input, _config) {
		return {
			listened: true,
			observed: false,
			row: "direct"
		};
	},
	channel: {
		allowed: (address, _config) => typeof address.user === "string" && address.user.length > 0,
		async send(_host, message) {
			const user = message.channel.address.user;
			if (!user) throw new Error("缺少微信收件人");
			const account = currentAccount();
			if (!account) throw new Error("微信来源尚未初始化");
			return account.sendText(user, message.text, message.id);
		},
		link: (address) => ({
			url: typeof address.user === "string" && address.user ? `weixin://` : "",
			label: localized("微信私聊", "WeChat DM")
		})
	},
	threadContext: {
		messageId: (trigger) => String(trigger.meta.messageId ?? trigger.id),
		async read(_commands, trigger, part, cursor, config) {
			if (part !== "thread") return {
				messages: [],
				body: {},
				status: part === "root" ? "no_root" : "no_parent"
			};
			const all = currentAccount()?.history(trigger.actor.id, config.historyLimit) ?? [];
			const offset = cursor ? Math.max(0, Number.parseInt(cursor, 10) || 0) : 0;
			const page = all.slice(offset, offset + config.readPageSize);
			const next = offset + config.readPageSize < all.length ? String(offset + config.readPageSize) : void 0;
			return {
				messages: page.map((message) => ({
					id: message.id,
					from: message.user,
					at: message.at,
					text: message.text
				})),
				...next ? { next } : {},
				body: {}
			};
		},
		images: () => []
	},
	policy: {
		schema: z.object({ allowed: z.array(z.object({
			id: z.string().trim().min(1).max(128),
			name: z.string().trim().max(100).optional()
		}).strict()).refine((entries) => new Set(entries.map((entry) => entry.id)).size === entries.length, "Duplicate user ids").default([]) }).strict(),
		fields: [{
			key: "allowed",
			type: "rows",
			label: localized("能发起任务的微信用户", "WeChat users who may originate work"),
			hint: localized("登录后设置页会显示你的 ilink_user_id，复制到这里。只有名单内的人的私聊会被裁定，名单外的一律忽略。", "After login the settings page shows your ilink_user_id; copy it here. Only listed users’ DMs are assessed; everyone else is ignored."),
			columns: [{
				key: "id",
				type: "text",
				label: localized("用户 ID", "User ID")
			}, {
				key: "name",
				type: "text",
				label: localized("名字", "Name"),
				optional: true
			}]
		}],
		explicit: localized("名单内的人私聊机器人，总是明确的请求；是否属于工作由接单规则判断。", "A listed user who DMs the bot always makes an explicit request; the accept rules decide whether it is work."),
		unnamed: {
			person: localized("微信用户", "WeChat user"),
			bot: localized("微信机器人", "WeChat bot")
		}
	}
};
// src/vendor/qrcode.mjs
/**
* qrcode
* @param typeNumber 1 to 40
* @param errorCorrectionLevel 'L','M','Q','H'
*/
const qrcode = function(typeNumber, errorCorrectionLevel) {
	const PAD0 = 236;
	const PAD1 = 17;
	let _typeNumber = typeNumber;
	const _errorCorrectionLevel = QRErrorCorrectionLevel[errorCorrectionLevel];
	let _modules = null;
	let _moduleCount = 0;
	let _dataCache = null;
	const _dataList = [];
	const _this = {};
	const makeImpl = function(test, maskPattern) {
		_moduleCount = _typeNumber * 4 + 17;
		_modules = function(moduleCount) {
			const modules = new Array(moduleCount);
			for (let row = 0; row < moduleCount; row += 1) {
				modules[row] = new Array(moduleCount);
				for (let col = 0; col < moduleCount; col += 1) modules[row][col] = null;
			}
			return modules;
		}(_moduleCount);
		setupPositionProbePattern(0, 0);
		setupPositionProbePattern(_moduleCount - 7, 0);
		setupPositionProbePattern(0, _moduleCount - 7);
		setupPositionAdjustPattern();
		setupTimingPattern();
		setupTypeInfo(test, maskPattern);
		if (_typeNumber >= 7) setupTypeNumber(test);
		if (_dataCache == null) _dataCache = createData(_typeNumber, _errorCorrectionLevel, _dataList);
		mapData(_dataCache, maskPattern);
	};
	const setupPositionProbePattern = function(row, col) {
		for (let r = -1; r <= 7; r += 1) {
			if (row + r <= -1 || _moduleCount <= row + r) continue;
			for (let c = -1; c <= 7; c += 1) {
				if (col + c <= -1 || _moduleCount <= col + c) continue;
				if (0 <= r && r <= 6 && (c == 0 || c == 6) || 0 <= c && c <= 6 && (r == 0 || r == 6) || 2 <= r && r <= 4 && 2 <= c && c <= 4) _modules[row + r][col + c] = true;
				else _modules[row + r][col + c] = false;
			}
		}
	};
	const getBestMaskPattern = function() {
		let minLostPoint = 0;
		let pattern = 0;
		for (let i = 0; i < 8; i += 1) {
			makeImpl(true, i);
			const lostPoint = QRUtil.getLostPoint(_this);
			if (i == 0 || minLostPoint > lostPoint) {
				minLostPoint = lostPoint;
				pattern = i;
			}
		}
		return pattern;
	};
	const setupTimingPattern = function() {
		for (let r = 8; r < _moduleCount - 8; r += 1) {
			if (_modules[r][6] != null) continue;
			_modules[r][6] = r % 2 == 0;
		}
		for (let c = 8; c < _moduleCount - 8; c += 1) {
			if (_modules[6][c] != null) continue;
			_modules[6][c] = c % 2 == 0;
		}
	};
	const setupPositionAdjustPattern = function() {
		const pos = QRUtil.getPatternPosition(_typeNumber);
		for (let i = 0; i < pos.length; i += 1) for (let j = 0; j < pos.length; j += 1) {
			const row = pos[i];
			const col = pos[j];
			if (_modules[row][col] != null) continue;
			for (let r = -2; r <= 2; r += 1) for (let c = -2; c <= 2; c += 1) if (r == -2 || r == 2 || c == -2 || c == 2 || r == 0 && c == 0) _modules[row + r][col + c] = true;
			else _modules[row + r][col + c] = false;
		}
	};
	const setupTypeNumber = function(test) {
		const bits = QRUtil.getBCHTypeNumber(_typeNumber);
		for (let i = 0; i < 18; i += 1) {
			const mod = !test && (bits >> i & 1) == 1;
			_modules[Math.floor(i / 3)][i % 3 + _moduleCount - 8 - 3] = mod;
		}
		for (let i = 0; i < 18; i += 1) {
			const mod = !test && (bits >> i & 1) == 1;
			_modules[i % 3 + _moduleCount - 8 - 3][Math.floor(i / 3)] = mod;
		}
	};
	const setupTypeInfo = function(test, maskPattern) {
		const data = _errorCorrectionLevel << 3 | maskPattern;
		const bits = QRUtil.getBCHTypeInfo(data);
		for (let i = 0; i < 15; i += 1) {
			const mod = !test && (bits >> i & 1) == 1;
			if (i < 6) _modules[i][8] = mod;
			else if (i < 8) _modules[i + 1][8] = mod;
			else _modules[_moduleCount - 15 + i][8] = mod;
		}
		for (let i = 0; i < 15; i += 1) {
			const mod = !test && (bits >> i & 1) == 1;
			if (i < 8) _modules[8][_moduleCount - i - 1] = mod;
			else if (i < 9) _modules[8][15 - i - 1 + 1] = mod;
			else _modules[8][15 - i - 1] = mod;
		}
		_modules[_moduleCount - 8][8] = !test;
	};
	const mapData = function(data, maskPattern) {
		let inc = -1;
		let row = _moduleCount - 1;
		let bitIndex = 7;
		let byteIndex = 0;
		const maskFunc = QRUtil.getMaskFunction(maskPattern);
		for (let col = _moduleCount - 1; col > 0; col -= 2) {
			if (col == 6) col -= 1;
			while (true) {
				for (let c = 0; c < 2; c += 1) if (_modules[row][col - c] == null) {
					let dark = false;
					if (byteIndex < data.length) dark = (data[byteIndex] >>> bitIndex & 1) == 1;
					if (maskFunc(row, col - c)) dark = !dark;
					_modules[row][col - c] = dark;
					bitIndex -= 1;
					if (bitIndex == -1) {
						byteIndex += 1;
						bitIndex = 7;
					}
				}
				row += inc;
				if (row < 0 || _moduleCount <= row) {
					row -= inc;
					inc = -inc;
					break;
				}
			}
		}
	};
	const createBytes = function(buffer, rsBlocks) {
		let offset = 0;
		let maxDcCount = 0;
		let maxEcCount = 0;
		const dcdata = new Array(rsBlocks.length);
		const ecdata = new Array(rsBlocks.length);
		for (let r = 0; r < rsBlocks.length; r += 1) {
			const dcCount = rsBlocks[r].dataCount;
			const ecCount = rsBlocks[r].totalCount - dcCount;
			maxDcCount = Math.max(maxDcCount, dcCount);
			maxEcCount = Math.max(maxEcCount, ecCount);
			dcdata[r] = new Array(dcCount);
			for (let i = 0; i < dcdata[r].length; i += 1) dcdata[r][i] = 255 & buffer.getBuffer()[i + offset];
			offset += dcCount;
			const rsPoly = QRUtil.getErrorCorrectPolynomial(ecCount);
			const modPoly = qrPolynomial(dcdata[r], rsPoly.getLength() - 1).mod(rsPoly);
			ecdata[r] = new Array(rsPoly.getLength() - 1);
			for (let i = 0; i < ecdata[r].length; i += 1) {
				const modIndex = i + modPoly.getLength() - ecdata[r].length;
				ecdata[r][i] = modIndex >= 0 ? modPoly.getAt(modIndex) : 0;
			}
		}
		let totalCodeCount = 0;
		for (let i = 0; i < rsBlocks.length; i += 1) totalCodeCount += rsBlocks[i].totalCount;
		const data = new Array(totalCodeCount);
		let index = 0;
		for (let i = 0; i < maxDcCount; i += 1) for (let r = 0; r < rsBlocks.length; r += 1) if (i < dcdata[r].length) {
			data[index] = dcdata[r][i];
			index += 1;
		}
		for (let i = 0; i < maxEcCount; i += 1) for (let r = 0; r < rsBlocks.length; r += 1) if (i < ecdata[r].length) {
			data[index] = ecdata[r][i];
			index += 1;
		}
		return data;
	};
	const createData = function(typeNumber, errorCorrectionLevel, dataList) {
		const rsBlocks = QRRSBlock.getRSBlocks(typeNumber, errorCorrectionLevel);
		const buffer = qrBitBuffer();
		for (let i = 0; i < dataList.length; i += 1) {
			const data = dataList[i];
			buffer.put(data.getMode(), 4);
			buffer.put(data.getLength(), QRUtil.getLengthInBits(data.getMode(), typeNumber));
			data.write(buffer);
		}
		let totalDataCount = 0;
		for (let i = 0; i < rsBlocks.length; i += 1) totalDataCount += rsBlocks[i].dataCount;
		if (buffer.getLengthInBits() > totalDataCount * 8) throw "code length overflow. (" + buffer.getLengthInBits() + ">" + totalDataCount * 8 + ")";
		if (buffer.getLengthInBits() + 4 <= totalDataCount * 8) buffer.put(0, 4);
		while (buffer.getLengthInBits() % 8 != 0) buffer.putBit(false);
		while (true) {
			if (buffer.getLengthInBits() >= totalDataCount * 8) break;
			buffer.put(PAD0, 8);
			if (buffer.getLengthInBits() >= totalDataCount * 8) break;
			buffer.put(PAD1, 8);
		}
		return createBytes(buffer, rsBlocks);
	};
	_this.addData = function(data, mode) {
		mode = mode || "Byte";
		let newData = null;
		switch (mode) {
			case "Numeric":
				newData = qrNumber(data);
				break;
			case "Alphanumeric":
				newData = qrAlphaNum(data);
				break;
			case "Byte":
				newData = qr8BitByte(data);
				break;
			case "Kanji":
				newData = qrKanji(data);
				break;
			default: throw "mode:" + mode;
		}
		_dataList.push(newData);
		_dataCache = null;
	};
	_this.isDark = function(row, col) {
		if (row < 0 || _moduleCount <= row || col < 0 || _moduleCount <= col) throw row + "," + col;
		return _modules[row][col];
	};
	_this.getModuleCount = function() {
		return _moduleCount;
	};
	_this.make = function() {
		if (_typeNumber < 1) {
			let typeNumber = 1;
			for (; typeNumber < 40; typeNumber++) {
				const rsBlocks = QRRSBlock.getRSBlocks(typeNumber, _errorCorrectionLevel);
				const buffer = qrBitBuffer();
				for (let i = 0; i < _dataList.length; i++) {
					const data = _dataList[i];
					buffer.put(data.getMode(), 4);
					buffer.put(data.getLength(), QRUtil.getLengthInBits(data.getMode(), typeNumber));
					data.write(buffer);
				}
				let totalDataCount = 0;
				for (let i = 0; i < rsBlocks.length; i++) totalDataCount += rsBlocks[i].dataCount;
				if (buffer.getLengthInBits() <= totalDataCount * 8) break;
			}
			_typeNumber = typeNumber;
		}
		makeImpl(false, getBestMaskPattern());
	};
	_this.createTableTag = function(cellSize, margin) {
		cellSize = cellSize || 2;
		margin = typeof margin == "undefined" ? cellSize * 4 : margin;
		let qrHtml = "";
		qrHtml += "<table style=\"";
		qrHtml += " border-width: 0px; border-style: none;";
		qrHtml += " border-collapse: collapse;";
		qrHtml += " padding: 0px; margin: " + margin + "px;";
		qrHtml += "\">";
		qrHtml += "<tbody>";
		for (let r = 0; r < _this.getModuleCount(); r += 1) {
			qrHtml += "<tr>";
			for (let c = 0; c < _this.getModuleCount(); c += 1) {
				qrHtml += "<td style=\"";
				qrHtml += " border-width: 0px; border-style: none;";
				qrHtml += " border-collapse: collapse;";
				qrHtml += " padding: 0px; margin: 0px;";
				qrHtml += " width: " + cellSize + "px;";
				qrHtml += " height: " + cellSize + "px;";
				qrHtml += " background-color: ";
				qrHtml += _this.isDark(r, c) ? "#000000" : "#ffffff";
				qrHtml += ";";
				qrHtml += "\"/>";
			}
			qrHtml += "</tr>";
		}
		qrHtml += "</tbody>";
		qrHtml += "</table>";
		return qrHtml;
	};
	_this.createSvgTag = function(cellSize, margin, alt, title) {
		let opts = {};
		if (typeof arguments[0] == "object") {
			opts = arguments[0];
			cellSize = opts.cellSize;
			margin = opts.margin;
			alt = opts.alt;
			title = opts.title;
		}
		cellSize = cellSize || 2;
		margin = typeof margin == "undefined" ? cellSize * 4 : margin;
		alt = typeof alt === "string" ? { text: alt } : alt || {};
		alt.text = alt.text || null;
		alt.id = alt.text ? alt.id || "qrcode-description" : null;
		title = typeof title === "string" ? { text: title } : title || {};
		title.text = title.text || null;
		title.id = title.text ? title.id || "qrcode-title" : null;
		const size = _this.getModuleCount() * cellSize + margin * 2;
		let c, mc, r, mr, qrSvg = "", rect;
		rect = "l" + cellSize + ",0 0," + cellSize + " -" + cellSize + ",0 0,-" + cellSize + "z ";
		qrSvg += "<svg version=\"1.1\" xmlns=\"http://www.w3.org/2000/svg\"";
		qrSvg += !opts.scalable ? " width=\"" + size + "px\" height=\"" + size + "px\"" : "";
		qrSvg += " viewBox=\"0 0 " + size + " " + size + "\" ";
		qrSvg += " preserveAspectRatio=\"xMinYMin meet\"";
		qrSvg += title.text || alt.text ? " role=\"img\" aria-labelledby=\"" + escapeXml([title.id, alt.id].join(" ").trim()) + "\"" : "";
		qrSvg += ">";
		qrSvg += title.text ? "<title id=\"" + escapeXml(title.id) + "\">" + escapeXml(title.text) + "</title>" : "";
		qrSvg += alt.text ? "<description id=\"" + escapeXml(alt.id) + "\">" + escapeXml(alt.text) + "</description>" : "";
		qrSvg += "<rect width=\"100%\" height=\"100%\" fill=\"white\" cx=\"0\" cy=\"0\"/>";
		qrSvg += "<path d=\"";
		for (r = 0; r < _this.getModuleCount(); r += 1) {
			mr = r * cellSize + margin;
			for (c = 0; c < _this.getModuleCount(); c += 1) if (_this.isDark(r, c)) {
				mc = c * cellSize + margin;
				qrSvg += "M" + mc + "," + mr + rect;
			}
		}
		qrSvg += "\" stroke=\"transparent\" fill=\"black\"/>";
		qrSvg += "</svg>";
		return qrSvg;
	};
	_this.createDataURL = function(cellSize, margin) {
		cellSize = cellSize || 2;
		margin = typeof margin == "undefined" ? cellSize * 4 : margin;
		const size = _this.getModuleCount() * cellSize + margin * 2;
		const min = margin;
		const max = size - margin;
		return createDataURL(size, size, function(x, y) {
			if (min <= x && x < max && min <= y && y < max) {
				const c = Math.floor((x - min) / cellSize);
				const r = Math.floor((y - min) / cellSize);
				return _this.isDark(r, c) ? 0 : 1;
			} else return 1;
		});
	};
	_this.createImgTag = function(cellSize, margin, alt) {
		cellSize = cellSize || 2;
		margin = typeof margin == "undefined" ? cellSize * 4 : margin;
		const size = _this.getModuleCount() * cellSize + margin * 2;
		let img = "";
		img += "<img";
		img += " src=\"";
		img += _this.createDataURL(cellSize, margin);
		img += "\"";
		img += " width=\"";
		img += size;
		img += "\"";
		img += " height=\"";
		img += size;
		img += "\"";
		if (alt) {
			img += " alt=\"";
			img += escapeXml(alt);
			img += "\"";
		}
		img += "/>";
		return img;
	};
	const escapeXml = function(s) {
		let escaped = "";
		for (let i = 0; i < s.length; i += 1) {
			const c = s.charAt(i);
			switch (c) {
				case "<":
					escaped += "&lt;";
					break;
				case ">":
					escaped += "&gt;";
					break;
				case "&":
					escaped += "&amp;";
					break;
				case "\"":
					escaped += "&quot;";
					break;
				default: escaped += c;
			}
		}
		return escaped;
	};
	const _createHalfASCII = function(margin) {
		const cellSize = 1;
		margin = typeof margin == "undefined" ? 2 : margin;
		const size = _this.getModuleCount() * cellSize + margin * 2;
		const min = margin;
		const max = size - margin;
		let y, x, r1, r2, p;
		const blocks = {
			"██": "█",
			"█ ": "▀",
			" █": "▄",
			"  ": " "
		};
		const blocksLastLineNoMargin = {
			"██": "▀",
			"█ ": "▀",
			" █": " ",
			"  ": " "
		};
		let ascii = "";
		for (y = 0; y < size; y += 2) {
			r1 = Math.floor((y - min) / cellSize);
			r2 = Math.floor((y + 1 - min) / cellSize);
			for (x = 0; x < size; x += 1) {
				p = "█";
				if (min <= x && x < max && min <= y && y < max && _this.isDark(r1, Math.floor((x - min) / cellSize))) p = " ";
				if (min <= x && x < max && min <= y + 1 && y + 1 < max && _this.isDark(r2, Math.floor((x - min) / cellSize))) p += " ";
				else p += "█";
				ascii += margin < 1 && y + 1 >= max ? blocksLastLineNoMargin[p] : blocks[p];
			}
			ascii += "\n";
		}
		if (size % 2 && margin > 0) return ascii.substring(0, ascii.length - size - 1) + Array(size + 1).join("▀");
		return ascii.substring(0, ascii.length - 1);
	};
	_this.createASCII = function(cellSize, margin) {
		cellSize = cellSize || 1;
		if (cellSize < 2) return _createHalfASCII(margin);
		cellSize -= 1;
		margin = typeof margin == "undefined" ? cellSize * 2 : margin;
		const size = _this.getModuleCount() * cellSize + margin * 2;
		const min = margin;
		const max = size - margin;
		let y, x, r, p;
		const white = Array(cellSize + 1).join("██");
		const black = Array(cellSize + 1).join("  ");
		let ascii = "";
		let line = "";
		for (y = 0; y < size; y += 1) {
			r = Math.floor((y - min) / cellSize);
			line = "";
			for (x = 0; x < size; x += 1) {
				p = 1;
				if (min <= x && x < max && min <= y && y < max && _this.isDark(r, Math.floor((x - min) / cellSize))) p = 0;
				line += p ? white : black;
			}
			for (r = 0; r < cellSize; r += 1) ascii += line + "\n";
		}
		return ascii.substring(0, ascii.length - 1);
	};
	_this.renderTo2dContext = function(context, cellSize) {
		cellSize = cellSize || 2;
		const length = _this.getModuleCount();
		for (let row = 0; row < length; row++) for (let col = 0; col < length; col++) {
			context.fillStyle = _this.isDark(row, col) ? "black" : "white";
			context.fillRect(col * cellSize, row * cellSize, cellSize, cellSize);
		}
	};
	return _this;
};
qrcode.stringToBytes = function(s) {
	const bytes = [];
	for (let i = 0; i < s.length; i += 1) {
		const c = s.charCodeAt(i);
		bytes.push(c & 255);
	}
	return bytes;
};
/**
* @param unicodeData base64 string of byte array.
* [16bit Unicode],[16bit Bytes], ...
* @param numChars
*/
qrcode.createStringToBytes = function(unicodeData, numChars) {
	const unicodeMap = function() {
		const bin = base64DecodeInputStream(unicodeData);
		const read = function() {
			const b = bin.read();
			if (b == -1) throw "eof";
			return b;
		};
		let count = 0;
		const unicodeMap = {};
		while (true) {
			const b0 = bin.read();
			if (b0 == -1) break;
			const b1 = read();
			const b2 = read();
			const b3 = read();
			const k = String.fromCharCode(b0 << 8 | b1);
			unicodeMap[k] = b2 << 8 | b3;
			count += 1;
		}
		if (count != numChars) throw count + " != " + numChars;
		return unicodeMap;
	}();
	const unknownChar = "?".charCodeAt(0);
	return function(s) {
		const bytes = [];
		for (let i = 0; i < s.length; i += 1) {
			const c = s.charCodeAt(i);
			if (c < 128) bytes.push(c);
			else {
				const b = unicodeMap[s.charAt(i)];
				if (typeof b == "number") {
					if ((b & 255) == b) bytes.push(b);
					else {
						bytes.push(b >>> 8);
						bytes.push(b & 255);
					}
				} else bytes.push(unknownChar);
			}
		}
		return bytes;
	};
};
const QRMode = {
	MODE_NUMBER: 1,
	MODE_ALPHA_NUM: 2,
	MODE_8BIT_BYTE: 4,
	MODE_KANJI: 8
};
const QRErrorCorrectionLevel = {
	L: 1,
	M: 0,
	Q: 3,
	H: 2
};
const QRMaskPattern = {
	PATTERN000: 0,
	PATTERN001: 1,
	PATTERN010: 2,
	PATTERN011: 3,
	PATTERN100: 4,
	PATTERN101: 5,
	PATTERN110: 6,
	PATTERN111: 7
};
const QRUtil = function() {
	const PATTERN_POSITION_TABLE = [
		[],
		[6, 18],
		[6, 22],
		[6, 26],
		[6, 30],
		[6, 34],
		[
			6,
			22,
			38
		],
		[
			6,
			24,
			42
		],
		[
			6,
			26,
			46
		],
		[
			6,
			28,
			50
		],
		[
			6,
			30,
			54
		],
		[
			6,
			32,
			58
		],
		[
			6,
			34,
			62
		],
		[
			6,
			26,
			46,
			66
		],
		[
			6,
			26,
			48,
			70
		],
		[
			6,
			26,
			50,
			74
		],
		[
			6,
			30,
			54,
			78
		],
		[
			6,
			30,
			56,
			82
		],
		[
			6,
			30,
			58,
			86
		],
		[
			6,
			34,
			62,
			90
		],
		[
			6,
			28,
			50,
			72,
			94
		],
		[
			6,
			26,
			50,
			74,
			98
		],
		[
			6,
			30,
			54,
			78,
			102
		],
		[
			6,
			28,
			54,
			80,
			106
		],
		[
			6,
			32,
			58,
			84,
			110
		],
		[
			6,
			30,
			58,
			86,
			114
		],
		[
			6,
			34,
			62,
			90,
			118
		],
		[
			6,
			26,
			50,
			74,
			98,
			122
		],
		[
			6,
			30,
			54,
			78,
			102,
			126
		],
		[
			6,
			26,
			52,
			78,
			104,
			130
		],
		[
			6,
			30,
			56,
			82,
			108,
			134
		],
		[
			6,
			34,
			60,
			86,
			112,
			138
		],
		[
			6,
			30,
			58,
			86,
			114,
			142
		],
		[
			6,
			34,
			62,
			90,
			118,
			146
		],
		[
			6,
			30,
			54,
			78,
			102,
			126,
			150
		],
		[
			6,
			24,
			50,
			76,
			102,
			128,
			154
		],
		[
			6,
			28,
			54,
			80,
			106,
			132,
			158
		],
		[
			6,
			32,
			58,
			84,
			110,
			136,
			162
		],
		[
			6,
			26,
			54,
			82,
			110,
			138,
			166
		],
		[
			6,
			30,
			58,
			86,
			114,
			142,
			170
		]
	];
	const G15 = 1335;
	const G18 = 7973;
	const G15_MASK = 21522;
	const _this = {};
	const getBCHDigit = function(data) {
		let digit = 0;
		while (data != 0) {
			digit += 1;
			data >>>= 1;
		}
		return digit;
	};
	_this.getBCHTypeInfo = function(data) {
		let d = data << 10;
		while (getBCHDigit(d) - getBCHDigit(G15) >= 0) d ^= G15 << getBCHDigit(d) - getBCHDigit(G15);
		return (data << 10 | d) ^ G15_MASK;
	};
	_this.getBCHTypeNumber = function(data) {
		let d = data << 12;
		while (getBCHDigit(d) - getBCHDigit(G18) >= 0) d ^= G18 << getBCHDigit(d) - getBCHDigit(G18);
		return data << 12 | d;
	};
	_this.getPatternPosition = function(typeNumber) {
		return PATTERN_POSITION_TABLE[typeNumber - 1];
	};
	_this.getMaskFunction = function(maskPattern) {
		switch (maskPattern) {
			case QRMaskPattern.PATTERN000: return function(i, j) {
				return (i + j) % 2 == 0;
			};
			case QRMaskPattern.PATTERN001: return function(i, j) {
				return i % 2 == 0;
			};
			case QRMaskPattern.PATTERN010: return function(i, j) {
				return j % 3 == 0;
			};
			case QRMaskPattern.PATTERN011: return function(i, j) {
				return (i + j) % 3 == 0;
			};
			case QRMaskPattern.PATTERN100: return function(i, j) {
				return (Math.floor(i / 2) + Math.floor(j / 3)) % 2 == 0;
			};
			case QRMaskPattern.PATTERN101: return function(i, j) {
				return i * j % 2 + i * j % 3 == 0;
			};
			case QRMaskPattern.PATTERN110: return function(i, j) {
				return (i * j % 2 + i * j % 3) % 2 == 0;
			};
			case QRMaskPattern.PATTERN111: return function(i, j) {
				return (i * j % 3 + (i + j) % 2) % 2 == 0;
			};
			default: throw "bad maskPattern:" + maskPattern;
		}
	};
	_this.getErrorCorrectPolynomial = function(errorCorrectLength) {
		let a = qrPolynomial([1], 0);
		for (let i = 0; i < errorCorrectLength; i += 1) a = a.multiply(qrPolynomial([1, QRMath.gexp(i)], 0));
		return a;
	};
	_this.getLengthInBits = function(mode, type) {
		if (1 <= type && type < 10) switch (mode) {
			case QRMode.MODE_NUMBER: return 10;
			case QRMode.MODE_ALPHA_NUM: return 9;
			case QRMode.MODE_8BIT_BYTE: return 8;
			case QRMode.MODE_KANJI: return 8;
			default: throw "mode:" + mode;
		}
		else if (type < 27) switch (mode) {
			case QRMode.MODE_NUMBER: return 12;
			case QRMode.MODE_ALPHA_NUM: return 11;
			case QRMode.MODE_8BIT_BYTE: return 16;
			case QRMode.MODE_KANJI: return 10;
			default: throw "mode:" + mode;
		}
		else if (type < 41) switch (mode) {
			case QRMode.MODE_NUMBER: return 14;
			case QRMode.MODE_ALPHA_NUM: return 13;
			case QRMode.MODE_8BIT_BYTE: return 16;
			case QRMode.MODE_KANJI: return 12;
			default: throw "mode:" + mode;
		}
		else throw "type:" + type;
	};
	_this.getLostPoint = function(qrcode) {
		const moduleCount = qrcode.getModuleCount();
		let lostPoint = 0;
		for (let row = 0; row < moduleCount; row += 1) for (let col = 0; col < moduleCount; col += 1) {
			let sameCount = 0;
			const dark = qrcode.isDark(row, col);
			for (let r = -1; r <= 1; r += 1) {
				if (row + r < 0 || moduleCount <= row + r) continue;
				for (let c = -1; c <= 1; c += 1) {
					if (col + c < 0 || moduleCount <= col + c) continue;
					if (r == 0 && c == 0) continue;
					if (dark == qrcode.isDark(row + r, col + c)) sameCount += 1;
				}
			}
			if (sameCount > 5) lostPoint += 3 + sameCount - 5;
		}
		for (let row = 0; row < moduleCount - 1; row += 1) for (let col = 0; col < moduleCount - 1; col += 1) {
			let count = 0;
			if (qrcode.isDark(row, col)) count += 1;
			if (qrcode.isDark(row + 1, col)) count += 1;
			if (qrcode.isDark(row, col + 1)) count += 1;
			if (qrcode.isDark(row + 1, col + 1)) count += 1;
			if (count == 0 || count == 4) lostPoint += 3;
		}
		for (let row = 0; row < moduleCount; row += 1) for (let col = 0; col < moduleCount - 6; col += 1) if (qrcode.isDark(row, col) && !qrcode.isDark(row, col + 1) && qrcode.isDark(row, col + 2) && qrcode.isDark(row, col + 3) && qrcode.isDark(row, col + 4) && !qrcode.isDark(row, col + 5) && qrcode.isDark(row, col + 6)) lostPoint += 40;
		for (let col = 0; col < moduleCount; col += 1) for (let row = 0; row < moduleCount - 6; row += 1) if (qrcode.isDark(row, col) && !qrcode.isDark(row + 1, col) && qrcode.isDark(row + 2, col) && qrcode.isDark(row + 3, col) && qrcode.isDark(row + 4, col) && !qrcode.isDark(row + 5, col) && qrcode.isDark(row + 6, col)) lostPoint += 40;
		let darkCount = 0;
		for (let col = 0; col < moduleCount; col += 1) for (let row = 0; row < moduleCount; row += 1) if (qrcode.isDark(row, col)) darkCount += 1;
		const ratio = Math.abs(100 * darkCount / moduleCount / moduleCount - 50) / 5;
		lostPoint += ratio * 10;
		return lostPoint;
	};
	return _this;
}();
const QRMath = function() {
	const EXP_TABLE = new Array(256);
	const LOG_TABLE = new Array(256);
	for (let i = 0; i < 8; i += 1) EXP_TABLE[i] = 1 << i;
	for (let i = 8; i < 256; i += 1) EXP_TABLE[i] = EXP_TABLE[i - 4] ^ EXP_TABLE[i - 5] ^ EXP_TABLE[i - 6] ^ EXP_TABLE[i - 8];
	for (let i = 0; i < 255; i += 1) LOG_TABLE[EXP_TABLE[i]] = i;
	const _this = {};
	_this.glog = function(n) {
		if (n < 1) throw "glog(" + n + ")";
		return LOG_TABLE[n];
	};
	_this.gexp = function(n) {
		while (n < 0) n += 255;
		while (n >= 256) n -= 255;
		return EXP_TABLE[n];
	};
	return _this;
}();
const qrPolynomial = function(num, shift) {
	if (typeof num.length == "undefined") throw num.length + "/" + shift;
	const _num = function() {
		let offset = 0;
		while (offset < num.length && num[offset] == 0) offset += 1;
		const _num = new Array(num.length - offset + shift);
		for (let i = 0; i < num.length - offset; i += 1) _num[i] = num[i + offset];
		return _num;
	}();
	const _this = {};
	_this.getAt = function(index) {
		return _num[index];
	};
	_this.getLength = function() {
		return _num.length;
	};
	_this.multiply = function(e) {
		const num = new Array(_this.getLength() + e.getLength() - 1);
		for (let i = 0; i < _this.getLength(); i += 1) for (let j = 0; j < e.getLength(); j += 1) num[i + j] ^= QRMath.gexp(QRMath.glog(_this.getAt(i)) + QRMath.glog(e.getAt(j)));
		return qrPolynomial(num, 0);
	};
	_this.mod = function(e) {
		if (_this.getLength() - e.getLength() < 0) return _this;
		const ratio = QRMath.glog(_this.getAt(0)) - QRMath.glog(e.getAt(0));
		const num = new Array(_this.getLength());
		for (let i = 0; i < _this.getLength(); i += 1) num[i] = _this.getAt(i);
		for (let i = 0; i < e.getLength(); i += 1) num[i] ^= QRMath.gexp(QRMath.glog(e.getAt(i)) + ratio);
		return qrPolynomial(num, 0).mod(e);
	};
	return _this;
};
const QRRSBlock = function() {
	const RS_BLOCK_TABLE = [
		[
			1,
			26,
			19
		],
		[
			1,
			26,
			16
		],
		[
			1,
			26,
			13
		],
		[
			1,
			26,
			9
		],
		[
			1,
			44,
			34
		],
		[
			1,
			44,
			28
		],
		[
			1,
			44,
			22
		],
		[
			1,
			44,
			16
		],
		[
			1,
			70,
			55
		],
		[
			1,
			70,
			44
		],
		[
			2,
			35,
			17
		],
		[
			2,
			35,
			13
		],
		[
			1,
			100,
			80
		],
		[
			2,
			50,
			32
		],
		[
			2,
			50,
			24
		],
		[
			4,
			25,
			9
		],
		[
			1,
			134,
			108
		],
		[
			2,
			67,
			43
		],
		[
			2,
			33,
			15,
			2,
			34,
			16
		],
		[
			2,
			33,
			11,
			2,
			34,
			12
		],
		[
			2,
			86,
			68
		],
		[
			4,
			43,
			27
		],
		[
			4,
			43,
			19
		],
		[
			4,
			43,
			15
		],
		[
			2,
			98,
			78
		],
		[
			4,
			49,
			31
		],
		[
			2,
			32,
			14,
			4,
			33,
			15
		],
		[
			4,
			39,
			13,
			1,
			40,
			14
		],
		[
			2,
			121,
			97
		],
		[
			2,
			60,
			38,
			2,
			61,
			39
		],
		[
			4,
			40,
			18,
			2,
			41,
			19
		],
		[
			4,
			40,
			14,
			2,
			41,
			15
		],
		[
			2,
			146,
			116
		],
		[
			3,
			58,
			36,
			2,
			59,
			37
		],
		[
			4,
			36,
			16,
			4,
			37,
			17
		],
		[
			4,
			36,
			12,
			4,
			37,
			13
		],
		[
			2,
			86,
			68,
			2,
			87,
			69
		],
		[
			4,
			69,
			43,
			1,
			70,
			44
		],
		[
			6,
			43,
			19,
			2,
			44,
			20
		],
		[
			6,
			43,
			15,
			2,
			44,
			16
		],
		[
			4,
			101,
			81
		],
		[
			1,
			80,
			50,
			4,
			81,
			51
		],
		[
			4,
			50,
			22,
			4,
			51,
			23
		],
		[
			3,
			36,
			12,
			8,
			37,
			13
		],
		[
			2,
			116,
			92,
			2,
			117,
			93
		],
		[
			6,
			58,
			36,
			2,
			59,
			37
		],
		[
			4,
			46,
			20,
			6,
			47,
			21
		],
		[
			7,
			42,
			14,
			4,
			43,
			15
		],
		[
			4,
			133,
			107
		],
		[
			8,
			59,
			37,
			1,
			60,
			38
		],
		[
			8,
			44,
			20,
			4,
			45,
			21
		],
		[
			12,
			33,
			11,
			4,
			34,
			12
		],
		[
			3,
			145,
			115,
			1,
			146,
			116
		],
		[
			4,
			64,
			40,
			5,
			65,
			41
		],
		[
			11,
			36,
			16,
			5,
			37,
			17
		],
		[
			11,
			36,
			12,
			5,
			37,
			13
		],
		[
			5,
			109,
			87,
			1,
			110,
			88
		],
		[
			5,
			65,
			41,
			5,
			66,
			42
		],
		[
			5,
			54,
			24,
			7,
			55,
			25
		],
		[
			11,
			36,
			12,
			7,
			37,
			13
		],
		[
			5,
			122,
			98,
			1,
			123,
			99
		],
		[
			7,
			73,
			45,
			3,
			74,
			46
		],
		[
			15,
			43,
			19,
			2,
			44,
			20
		],
		[
			3,
			45,
			15,
			13,
			46,
			16
		],
		[
			1,
			135,
			107,
			5,
			136,
			108
		],
		[
			10,
			74,
			46,
			1,
			75,
			47
		],
		[
			1,
			50,
			22,
			15,
			51,
			23
		],
		[
			2,
			42,
			14,
			17,
			43,
			15
		],
		[
			5,
			150,
			120,
			1,
			151,
			121
		],
		[
			9,
			69,
			43,
			4,
			70,
			44
		],
		[
			17,
			50,
			22,
			1,
			51,
			23
		],
		[
			2,
			42,
			14,
			19,
			43,
			15
		],
		[
			3,
			141,
			113,
			4,
			142,
			114
		],
		[
			3,
			70,
			44,
			11,
			71,
			45
		],
		[
			17,
			47,
			21,
			4,
			48,
			22
		],
		[
			9,
			39,
			13,
			16,
			40,
			14
		],
		[
			3,
			135,
			107,
			5,
			136,
			108
		],
		[
			3,
			67,
			41,
			13,
			68,
			42
		],
		[
			15,
			54,
			24,
			5,
			55,
			25
		],
		[
			15,
			43,
			15,
			10,
			44,
			16
		],
		[
			4,
			144,
			116,
			4,
			145,
			117
		],
		[
			17,
			68,
			42
		],
		[
			17,
			50,
			22,
			6,
			51,
			23
		],
		[
			19,
			46,
			16,
			6,
			47,
			17
		],
		[
			2,
			139,
			111,
			7,
			140,
			112
		],
		[
			17,
			74,
			46
		],
		[
			7,
			54,
			24,
			16,
			55,
			25
		],
		[
			34,
			37,
			13
		],
		[
			4,
			151,
			121,
			5,
			152,
			122
		],
		[
			4,
			75,
			47,
			14,
			76,
			48
		],
		[
			11,
			54,
			24,
			14,
			55,
			25
		],
		[
			16,
			45,
			15,
			14,
			46,
			16
		],
		[
			6,
			147,
			117,
			4,
			148,
			118
		],
		[
			6,
			73,
			45,
			14,
			74,
			46
		],
		[
			11,
			54,
			24,
			16,
			55,
			25
		],
		[
			30,
			46,
			16,
			2,
			47,
			17
		],
		[
			8,
			132,
			106,
			4,
			133,
			107
		],
		[
			8,
			75,
			47,
			13,
			76,
			48
		],
		[
			7,
			54,
			24,
			22,
			55,
			25
		],
		[
			22,
			45,
			15,
			13,
			46,
			16
		],
		[
			10,
			142,
			114,
			2,
			143,
			115
		],
		[
			19,
			74,
			46,
			4,
			75,
			47
		],
		[
			28,
			50,
			22,
			6,
			51,
			23
		],
		[
			33,
			46,
			16,
			4,
			47,
			17
		],
		[
			8,
			152,
			122,
			4,
			153,
			123
		],
		[
			22,
			73,
			45,
			3,
			74,
			46
		],
		[
			8,
			53,
			23,
			26,
			54,
			24
		],
		[
			12,
			45,
			15,
			28,
			46,
			16
		],
		[
			3,
			147,
			117,
			10,
			148,
			118
		],
		[
			3,
			73,
			45,
			23,
			74,
			46
		],
		[
			4,
			54,
			24,
			31,
			55,
			25
		],
		[
			11,
			45,
			15,
			31,
			46,
			16
		],
		[
			7,
			146,
			116,
			7,
			147,
			117
		],
		[
			21,
			73,
			45,
			7,
			74,
			46
		],
		[
			1,
			53,
			23,
			37,
			54,
			24
		],
		[
			19,
			45,
			15,
			26,
			46,
			16
		],
		[
			5,
			145,
			115,
			10,
			146,
			116
		],
		[
			19,
			75,
			47,
			10,
			76,
			48
		],
		[
			15,
			54,
			24,
			25,
			55,
			25
		],
		[
			23,
			45,
			15,
			25,
			46,
			16
		],
		[
			13,
			145,
			115,
			3,
			146,
			116
		],
		[
			2,
			74,
			46,
			29,
			75,
			47
		],
		[
			42,
			54,
			24,
			1,
			55,
			25
		],
		[
			23,
			45,
			15,
			28,
			46,
			16
		],
		[
			17,
			145,
			115
		],
		[
			10,
			74,
			46,
			23,
			75,
			47
		],
		[
			10,
			54,
			24,
			35,
			55,
			25
		],
		[
			19,
			45,
			15,
			35,
			46,
			16
		],
		[
			17,
			145,
			115,
			1,
			146,
			116
		],
		[
			14,
			74,
			46,
			21,
			75,
			47
		],
		[
			29,
			54,
			24,
			19,
			55,
			25
		],
		[
			11,
			45,
			15,
			46,
			46,
			16
		],
		[
			13,
			145,
			115,
			6,
			146,
			116
		],
		[
			14,
			74,
			46,
			23,
			75,
			47
		],
		[
			44,
			54,
			24,
			7,
			55,
			25
		],
		[
			59,
			46,
			16,
			1,
			47,
			17
		],
		[
			12,
			151,
			121,
			7,
			152,
			122
		],
		[
			12,
			75,
			47,
			26,
			76,
			48
		],
		[
			39,
			54,
			24,
			14,
			55,
			25
		],
		[
			22,
			45,
			15,
			41,
			46,
			16
		],
		[
			6,
			151,
			121,
			14,
			152,
			122
		],
		[
			6,
			75,
			47,
			34,
			76,
			48
		],
		[
			46,
			54,
			24,
			10,
			55,
			25
		],
		[
			2,
			45,
			15,
			64,
			46,
			16
		],
		[
			17,
			152,
			122,
			4,
			153,
			123
		],
		[
			29,
			74,
			46,
			14,
			75,
			47
		],
		[
			49,
			54,
			24,
			10,
			55,
			25
		],
		[
			24,
			45,
			15,
			46,
			46,
			16
		],
		[
			4,
			152,
			122,
			18,
			153,
			123
		],
		[
			13,
			74,
			46,
			32,
			75,
			47
		],
		[
			48,
			54,
			24,
			14,
			55,
			25
		],
		[
			42,
			45,
			15,
			32,
			46,
			16
		],
		[
			20,
			147,
			117,
			4,
			148,
			118
		],
		[
			40,
			75,
			47,
			7,
			76,
			48
		],
		[
			43,
			54,
			24,
			22,
			55,
			25
		],
		[
			10,
			45,
			15,
			67,
			46,
			16
		],
		[
			19,
			148,
			118,
			6,
			149,
			119
		],
		[
			18,
			75,
			47,
			31,
			76,
			48
		],
		[
			34,
			54,
			24,
			34,
			55,
			25
		],
		[
			20,
			45,
			15,
			61,
			46,
			16
		]
	];
	const qrRSBlock = function(totalCount, dataCount) {
		const _this = {};
		_this.totalCount = totalCount;
		_this.dataCount = dataCount;
		return _this;
	};
	const _this = {};
	const getRsBlockTable = function(typeNumber, errorCorrectionLevel) {
		switch (errorCorrectionLevel) {
			case QRErrorCorrectionLevel.L: return RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 0];
			case QRErrorCorrectionLevel.M: return RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 1];
			case QRErrorCorrectionLevel.Q: return RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 2];
			case QRErrorCorrectionLevel.H: return RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 3];
			default: return;
		}
	};
	_this.getRSBlocks = function(typeNumber, errorCorrectionLevel) {
		const rsBlock = getRsBlockTable(typeNumber, errorCorrectionLevel);
		if (typeof rsBlock == "undefined") throw "bad rs block @ typeNumber:" + typeNumber + "/errorCorrectionLevel:" + errorCorrectionLevel;
		const length = rsBlock.length / 3;
		const list = [];
		for (let i = 0; i < length; i += 1) {
			const count = rsBlock[i * 3 + 0];
			const totalCount = rsBlock[i * 3 + 1];
			const dataCount = rsBlock[i * 3 + 2];
			for (let j = 0; j < count; j += 1) list.push(qrRSBlock(totalCount, dataCount));
		}
		return list;
	};
	return _this;
}();
const qrBitBuffer = function() {
	const _buffer = [];
	let _length = 0;
	const _this = {};
	_this.getBuffer = function() {
		return _buffer;
	};
	_this.getAt = function(index) {
		const bufIndex = Math.floor(index / 8);
		return (_buffer[bufIndex] >>> 7 - index % 8 & 1) == 1;
	};
	_this.put = function(num, length) {
		for (let i = 0; i < length; i += 1) _this.putBit((num >>> length - i - 1 & 1) == 1);
	};
	_this.getLengthInBits = function() {
		return _length;
	};
	_this.putBit = function(bit) {
		const bufIndex = Math.floor(_length / 8);
		if (_buffer.length <= bufIndex) _buffer.push(0);
		if (bit) _buffer[bufIndex] |= 128 >>> _length % 8;
		_length += 1;
	};
	return _this;
};
const qrNumber = function(data) {
	const _mode = QRMode.MODE_NUMBER;
	const _data = data;
	const _this = {};
	_this.getMode = function() {
		return _mode;
	};
	_this.getLength = function(buffer) {
		return _data.length;
	};
	_this.write = function(buffer) {
		const data = _data;
		let i = 0;
		while (i + 2 < data.length) {
			buffer.put(strToNum(data.substring(i, i + 3)), 10);
			i += 3;
		}
		if (i < data.length) {
			if (data.length - i == 1) buffer.put(strToNum(data.substring(i, i + 1)), 4);
			else if (data.length - i == 2) buffer.put(strToNum(data.substring(i, i + 2)), 7);
		}
	};
	const strToNum = function(s) {
		let num = 0;
		for (let i = 0; i < s.length; i += 1) num = num * 10 + chatToNum(s.charAt(i));
		return num;
	};
	const chatToNum = function(c) {
		if ("0" <= c && c <= "9") return c.charCodeAt(0) - "0".charCodeAt(0);
		throw "illegal char :" + c;
	};
	return _this;
};
const qrAlphaNum = function(data) {
	const _mode = QRMode.MODE_ALPHA_NUM;
	const _data = data;
	const _this = {};
	_this.getMode = function() {
		return _mode;
	};
	_this.getLength = function(buffer) {
		return _data.length;
	};
	_this.write = function(buffer) {
		const s = _data;
		let i = 0;
		while (i + 1 < s.length) {
			buffer.put(getCode(s.charAt(i)) * 45 + getCode(s.charAt(i + 1)), 11);
			i += 2;
		}
		if (i < s.length) buffer.put(getCode(s.charAt(i)), 6);
	};
	const getCode = function(c) {
		if ("0" <= c && c <= "9") return c.charCodeAt(0) - "0".charCodeAt(0);
		else if ("A" <= c && c <= "Z") return c.charCodeAt(0) - "A".charCodeAt(0) + 10;
		else switch (c) {
			case " ": return 36;
			case "$": return 37;
			case "%": return 38;
			case "*": return 39;
			case "+": return 40;
			case "-": return 41;
			case ".": return 42;
			case "/": return 43;
			case ":": return 44;
			default: throw "illegal char :" + c;
		}
	};
	return _this;
};
const qr8BitByte = function(data) {
	const _mode = QRMode.MODE_8BIT_BYTE;
	const _bytes = qrcode.stringToBytes(data);
	const _this = {};
	_this.getMode = function() {
		return _mode;
	};
	_this.getLength = function(buffer) {
		return _bytes.length;
	};
	_this.write = function(buffer) {
		for (let i = 0; i < _bytes.length; i += 1) buffer.put(_bytes[i], 8);
	};
	return _this;
};
const qrKanji = function(data) {
	const _mode = QRMode.MODE_KANJI;
	const stringToBytes = qrcode.stringToBytes;
	(function(c, code) {
		const test = stringToBytes(c);
		if (test.length != 2 || (test[0] << 8 | test[1]) != code) throw "sjis not supported.";
	})("友", 38726);
	const _bytes = stringToBytes(data);
	const _this = {};
	_this.getMode = function() {
		return _mode;
	};
	_this.getLength = function(buffer) {
		return ~~(_bytes.length / 2);
	};
	_this.write = function(buffer) {
		const data = _bytes;
		let i = 0;
		while (i + 1 < data.length) {
			let c = (255 & data[i]) << 8 | 255 & data[i + 1];
			if (33088 <= c && c <= 40956) c -= 33088;
			else if (57408 <= c && c <= 60351) c -= 49472;
			else throw "illegal char at " + (i + 1) + "/" + c;
			c = (c >>> 8 & 255) * 192 + (c & 255);
			buffer.put(c, 13);
			i += 2;
		}
		if (i < data.length) throw "illegal char at " + (i + 1);
	};
	return _this;
};
const byteArrayOutputStream = function() {
	const _bytes = [];
	const _this = {};
	_this.writeByte = function(b) {
		_bytes.push(b & 255);
	};
	_this.writeShort = function(i) {
		_this.writeByte(i);
		_this.writeByte(i >>> 8);
	};
	_this.writeBytes = function(b, off, len) {
		off = off || 0;
		len = len || b.length;
		for (let i = 0; i < len; i += 1) _this.writeByte(b[i + off]);
	};
	_this.writeString = function(s) {
		for (let i = 0; i < s.length; i += 1) _this.writeByte(s.charCodeAt(i));
	};
	_this.toByteArray = function() {
		return _bytes;
	};
	_this.toString = function() {
		let s = "";
		s += "[";
		for (let i = 0; i < _bytes.length; i += 1) {
			if (i > 0) s += ",";
			s += _bytes[i];
		}
		s += "]";
		return s;
	};
	return _this;
};
const base64EncodeOutputStream = function() {
	let _buffer = 0;
	let _buflen = 0;
	let _length = 0;
	let _base64 = "";
	const _this = {};
	const writeEncoded = function(b) {
		_base64 += String.fromCharCode(encode(b & 63));
	};
	const encode = function(n) {
		if (n < 0) throw "n:" + n;
		else if (n < 26) return 65 + n;
		else if (n < 52) return 97 + (n - 26);
		else if (n < 62) return 48 + (n - 52);
		else if (n == 62) return 43;
		else if (n == 63) return 47;
		else throw "n:" + n;
	};
	_this.writeByte = function(n) {
		_buffer = _buffer << 8 | n & 255;
		_buflen += 8;
		_length += 1;
		while (_buflen >= 6) {
			writeEncoded(_buffer >>> _buflen - 6);
			_buflen -= 6;
		}
	};
	_this.flush = function() {
		if (_buflen > 0) {
			writeEncoded(_buffer << 6 - _buflen);
			_buffer = 0;
			_buflen = 0;
		}
		if (_length % 3 != 0) {
			const padlen = 3 - _length % 3;
			for (let i = 0; i < padlen; i += 1) _base64 += "=";
		}
	};
	_this.toString = function() {
		return _base64;
	};
	return _this;
};
const base64DecodeInputStream = function(str) {
	const _str = str;
	let _pos = 0;
	let _buffer = 0;
	let _buflen = 0;
	const _this = {};
	_this.read = function() {
		while (_buflen < 8) {
			if (_pos >= _str.length) {
				if (_buflen == 0) return -1;
				throw "unexpected end of file./" + _buflen;
			}
			const c = _str.charAt(_pos);
			_pos += 1;
			if (c == "=") {
				_buflen = 0;
				return -1;
			} else if (c.match(/^\s$/)) continue;
			_buffer = _buffer << 6 | decode(c.charCodeAt(0));
			_buflen += 6;
		}
		const n = _buffer >>> _buflen - 8 & 255;
		_buflen -= 8;
		return n;
	};
	const decode = function(c) {
		if (65 <= c && c <= 90) return c - 65;
		else if (97 <= c && c <= 122) return c - 97 + 26;
		else if (48 <= c && c <= 57) return c - 48 + 52;
		else if (c == 43) return 62;
		else if (c == 47) return 63;
		else throw "c:" + c;
	};
	return _this;
};
const gifImage = function(width, height) {
	const _width = width;
	const _height = height;
	const _data = new Array(width * height);
	const _this = {};
	_this.setPixel = function(x, y, pixel) {
		_data[y * _width + x] = pixel;
	};
	_this.write = function(out) {
		out.writeString("GIF87a");
		out.writeShort(_width);
		out.writeShort(_height);
		out.writeByte(128);
		out.writeByte(0);
		out.writeByte(0);
		out.writeByte(0);
		out.writeByte(0);
		out.writeByte(0);
		out.writeByte(255);
		out.writeByte(255);
		out.writeByte(255);
		out.writeString(",");
		out.writeShort(0);
		out.writeShort(0);
		out.writeShort(_width);
		out.writeShort(_height);
		out.writeByte(0);
		const lzwMinCodeSize = 2;
		const raster = getLZWRaster(lzwMinCodeSize);
		out.writeByte(lzwMinCodeSize);
		let offset = 0;
		while (raster.length - offset > 255) {
			out.writeByte(255);
			out.writeBytes(raster, offset, 255);
			offset += 255;
		}
		out.writeByte(raster.length - offset);
		out.writeBytes(raster, offset, raster.length - offset);
		out.writeByte(0);
		out.writeString(";");
	};
	const bitOutputStream = function(out) {
		const _out = out;
		let _bitLength = 0;
		let _bitBuffer = 0;
		const _this = {};
		_this.write = function(data, length) {
			if (data >>> length != 0) throw "length over";
			while (_bitLength + length >= 8) {
				_out.writeByte(255 & (data << _bitLength | _bitBuffer));
				length -= 8 - _bitLength;
				data >>>= 8 - _bitLength;
				_bitBuffer = 0;
				_bitLength = 0;
			}
			_bitBuffer = data << _bitLength | _bitBuffer;
			_bitLength = _bitLength + length;
		};
		_this.flush = function() {
			if (_bitLength > 0) _out.writeByte(_bitBuffer);
		};
		return _this;
	};
	const getLZWRaster = function(lzwMinCodeSize) {
		const clearCode = 1 << lzwMinCodeSize;
		const endCode = (1 << lzwMinCodeSize) + 1;
		let bitLength = lzwMinCodeSize + 1;
		const table = lzwTable();
		for (let i = 0; i < clearCode; i += 1) table.add(String.fromCharCode(i));
		table.add(String.fromCharCode(clearCode));
		table.add(String.fromCharCode(endCode));
		const byteOut = byteArrayOutputStream();
		const bitOut = bitOutputStream(byteOut);
		bitOut.write(clearCode, bitLength);
		let dataIndex = 0;
		let s = String.fromCharCode(_data[dataIndex]);
		dataIndex += 1;
		while (dataIndex < _data.length) {
			const c = String.fromCharCode(_data[dataIndex]);
			dataIndex += 1;
			if (table.contains(s + c)) s = s + c;
			else {
				bitOut.write(table.indexOf(s), bitLength);
				if (table.size() < 4095) {
					if (table.size() == 1 << bitLength) bitLength += 1;
					table.add(s + c);
				}
				s = c;
			}
		}
		bitOut.write(table.indexOf(s), bitLength);
		bitOut.write(endCode, bitLength);
		bitOut.flush();
		return byteOut.toByteArray();
	};
	const lzwTable = function() {
		const _map = {};
		let _size = 0;
		const _this = {};
		_this.add = function(key) {
			if (_this.contains(key)) throw "dup key:" + key;
			_map[key] = _size;
			_size += 1;
		};
		_this.size = function() {
			return _size;
		};
		_this.indexOf = function(key) {
			return _map[key];
		};
		_this.contains = function(key) {
			return typeof _map[key] != "undefined";
		};
		return _this;
	};
	return _this;
};
const createDataURL = function(width, height, getPixel) {
	const gif = gifImage(width, height);
	for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) gif.setPixel(x, y, getPixel(x, y));
	const b = byteArrayOutputStream();
	gif.write(b);
	const base64 = base64EncodeOutputStream();
	const bytes = b.toByteArray();
	for (let i = 0; i < bytes.length; i += 1) base64.writeByte(bytes[i]);
	base64.flush();
	return "data:image/gif;base64," + base64;
};
qrcode.stringToBytes;
// src/qr.ts
/**
* The iLink `qrcode_img_content` value is an HTML page URL, not an image;
* `<img src>` cannot show it. Encode the URL into an SVG QR ourselves with the
* vendored MIT encoder (qrcode-generator, Kazuhiko Arase).
*/
function qrSvgFor(url) {
	const qr = qrcode(0, "M");
	qr.addData(url);
	qr.make();
	return qr.createSvgTag({
		cellSize: 2,
		margin: 2,
		scalable: true
	});
}
// src/routes.ts
const HEADER = "x-agent-wechat-request";
/** Allows the local settings page only: an explicit request header and a same-origin Origin when present. */
function sameOrigin(req) {
	if (req.headers[HEADER] !== "1") return false;
	const origin = req.headers.origin;
	return origin === void 0 || origin === `http://${req.headers.host}`;
}
function sendJson(res, status, value) {
	res.statusCode = status;
	res.setHeader("Content-Type", "application/json; charset=utf-8");
	res.setHeader("Cache-Control", "no-store");
	res.end(JSON.stringify(value));
}
async function readJson(req) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		size += buffer.length;
		if (size > 4096) throw new Error("请求体过大");
		chunks.push(buffer);
	}
	if (!size) return {};
	const parsed = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("请求体必须是 JSON 对象");
	return parsed;
}
function registerRoutes(server, account) {
	server.register({
		kind: "exact",
		path: "/agent-wechat/api/status",
		handler: (req, res) => {
			if (!sameOrigin(req)) return sendJson(res, 403, { ok: false });
			sendJson(res, 200, {
				ok: true,
				...account.status()
			});
		}
	});
	server.register({
		kind: "exact",
		path: "/agent-wechat/api/qr",
		handler: (req, res) => {
			if (!sameOrigin(req)) return sendJson(res, 403, { ok: false });
			const state = account.qr();
			let svg = "";
			if (state.qrUrl) try {
				svg = qrSvgFor(state.qrUrl);
			} catch {
				svg = "";
			}
			sendJson(res, 200, {
				ok: true,
				...state,
				svg
			});
		}
	});
	server.register({
		kind: "exact",
		path: "/agent-wechat/api/verify-code",
		handler: async (req, res) => {
			if (!sameOrigin(req)) return sendJson(res, 403, { ok: false });
			try {
				const body = await readJson(req);
				const code = typeof body.code === "string" ? body.code.replace(/\D/g, "") : "";
				if (!code) return sendJson(res, 400, {
					ok: false,
					message: "请输入手机上显示的数字"
				});
				const accepted = account.submitVerifyCode(code);
				sendJson(res, accepted ? 200 : 409, {
					ok: accepted,
					message: accepted ? "已提交，等待确认" : "当前不需要输入数字"
				});
			} catch (error) {
				sendJson(res, 400, {
					ok: false,
					message: String(error).slice(0, 200)
				});
			}
		}
	});
	server.register({
		kind: "exact",
		path: "/agent-wechat/api/relogin",
		handler: (req, res) => {
			if (!sameOrigin(req)) return sendJson(res, 403, { ok: false });
			account.relogin();
			sendJson(res, 200, { ok: true });
		}
	});
	server.register({
		kind: "exact",
		path: "/agent-wechat/api/logout",
		handler: (req, res) => {
			if (!sameOrigin(req)) return sendJson(res, 403, { ok: false });
			account.logout();
			sendJson(res, 200, { ok: true });
		}
	});
}
// src/index.ts
/**
* dsh-superagent-wechat-source — host plugin entry.
*
* Registers the `wechat` Source kind, starts the QR login or the long poll,
* and serves the settings-page API. Runtime imports stay free of
* `@deepseek-ai/*`: the host is reached through the `orchestrator` service.
*/
const name = "dsh-superagent-wechat-source";
const inject = ["orchestrator"];
/** Where account state goes when the profile does not point at dsh-superagent's stateDir. */
const DEFAULT_STATE_DIR = join(homedir(), ".dsh-superagent-wechat");
function apply(ctx, config = {}) {
	const stateDir = typeof config.stateDir === "string" && config.stateDir ? config.stateDir : DEFAULT_STATE_DIR;
	const source = {
		kind: wechatKind.kind,
		health: wechatKind.health
	};
	const account = new Account({
		stateDir,
		historyLimit: typeof config.historyLimit === "number" ? config.historyLimit : wechatKind.schema.parse({}).historyLimit,
		receive: (trigger) => ctx.orchestrator.context(source).receive(trigger),
		report: (state, detail) => {
			try {
				ctx.orchestrator.context(source).report("wechat", {
					state,
					detail
				});
			} catch {}
		}
	});
	setAccount(account);
	ctx.effect(() => ctx.orchestrator.sources.register(wechatKind));
	ctx.effect(() => {
		account.start();
		return () => {
			account.stop();
			setAccount(void 0);
		};
	});
	ctx.inject(["webServer"], (child) => {
		const server = child.get("webServer");
		if (server) registerRoutes(server, account);
	});
}
export { DEFAULT_STATE_DIR, apply, inject, name };
