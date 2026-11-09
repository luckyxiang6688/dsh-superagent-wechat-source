/** Settings → 微信私聊: login state, QR, PIN, relogin/logout, usage notes. */
import { createElement, Fragment, useCallback, useEffect, useRef, useState, type ReactElement } from 'react'

interface LoginState {
  phase: 'idle' | 'waiting' | 'scanned' | 'need_verifycode' | 'confirmed' | 'expired' | 'error' | 'already_bound'
  qrUrl?: string
  expiresAt?: string
  error?: string
}

interface Status {
  ok?: boolean
  loggedIn: boolean
  botId?: string
  userId?: string
  polling: boolean
  lastPollAt?: string
  error?: string
  login: LoginState
  conflict?: { path: string; userId?: string; sameAccount: boolean }
}

interface Qr extends LoginState { svg?: string }

const HEADERS = { 'x-agent-wechat-request': '1' }

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path, { headers: HEADERS, cache: 'no-store' })
  return response.json() as Promise<T>
}

async function postJson<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { ...HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
  return response.json() as Promise<T>
}

const PHASE_TEXT: Record<string, string> = {
  idle: '准备中…',
  waiting: '请用微信扫描二维码',
  scanned: '已扫码，请在手机上确认',
  need_verifycode: '请输入手机上显示的数字',
  confirmed: '登录成功',
  expired: '二维码已失效，请重新获取',
  error: '登录出错',
  already_bound: '该微信号已绑定到其他客户端',
}

const styles = {
  section: { display: 'flex', flexDirection: 'column' as const, gap: 16, padding: '0 24px 24px' },
  card: { border: '1px solid rgba(128,128,128,.3)', borderRadius: 12, padding: '14px 16px', display: 'flex', flexDirection: 'column' as const, gap: 10 },
  row: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' as const },
  title: { fontWeight: 600, fontSize: 14 },
  badge: { fontSize: 11, padding: '2px 8px', borderRadius: 8, border: '1px solid rgba(128,128,128,.4)' },
  ok: { color: '#2e7d32', borderColor: '#2e7d32' },
  warn: { color: '#ed6c02', borderColor: '#ed6c02' },
  bad: { color: '#c62828', borderColor: '#c62828' },
  hint: { fontSize: 12, opacity: 0.75, lineHeight: 1.6 },
  mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12 },
  input: { padding: '6px 10px', borderRadius: 8, border: '1px solid rgba(128,128,128,.4)', background: 'transparent', color: 'inherit', width: 140 },
  button: { padding: '6px 14px', borderRadius: 8, border: '1px solid rgba(128,128,128,.4)', background: 'transparent', color: 'inherit', cursor: 'pointer' },
  qr: { width: 220, height: 220, background: '#fff', padding: 8, borderRadius: 8, alignSelf: 'flex-start' as const },
}

export function Settings(): ReactElement {
  const [status, setStatus] = useState<Status | undefined>()
  const [qr, setQr] = useState<Qr | undefined>()
  const [code, setCode] = useState('')
  const [notice, setNotice] = useState('')

  const refresh = useCallback(async () => {
    try {
      const next = await getJson<Status>('/agent-wechat/api/status')
      setStatus(next)
      setQr(next.loggedIn ? undefined : await getJson<Qr>('/agent-wechat/api/qr'))
    } catch {
      // The host may still be starting; the next tick retries.
    }
  }, [])

  useEffect(() => {
    void refresh()
    const interval = setInterval(() => { void refresh() }, status?.loggedIn === false ? 2000 : 5000)
    return () => clearInterval(interval)
  }, [refresh, status?.loggedIn])

  const act = async (path: string, body?: unknown): Promise<void> => {
    setNotice('')
    try {
      const result = await postJson<{ ok?: boolean; message?: string }>(path, body)
      if (!result.ok) setNotice(result.message ?? '操作未完成')
    } catch (error) {
      setNotice(String(error).slice(0, 200))
    }
    await refresh()
  }

  // The login loop gives up after a few QR refreshes. When the panel is opened
  // later and finds it in that terminal state, fetch a fresh code once —
  // otherwise the user stares at a dead QR until they find the button.
  const autoRetried = useRef(false)
  useEffect(() => {
    if (autoRetried.current || status?.loggedIn) return
    const current = status?.login.phase
    if (current !== 'expired' && current !== 'error') return
    autoRetried.current = true
    void act('/agent-wechat/api/relogin')
  }, [status?.loggedIn, status?.login.phase])

  const phase = status?.login.phase ?? 'idle'
  const badge = status?.loggedIn
    ? { text: '已登录', style: styles.ok }
    : phase === 'error' || phase === 'already_bound' || phase === 'expired'
      ? { text: PHASE_TEXT[phase] ?? phase, style: styles.bad }
      : { text: PHASE_TEXT[phase] ?? phase, style: styles.warn }

  return (
    <div style={styles.section}>
      <div style={styles.card}>
        <div style={styles.row}>
          <span style={styles.title}>微信私聊 · superagent 来源</span>
          <span style={{ ...styles.badge, ...badge.style }}>{badge.text}</span>
        </div>

        {status?.conflict && (
          <div style={{ ...styles.hint, color: '#c62828' }}>
            检测到本机 dsh-wechat 已登录{status.conflict.userId ? `（${status.conflict.userId}）` : ''}。
            一个微信号只能连一个 bot 客户端，请二选一：停用 dsh-wechat，或换一个微信号。
            {status.conflict.sameAccount ? ' 当前登录的正是同一个微信号。' : ''}
          </div>
        )}

        {!status?.loggedIn && qr?.svg && qr.phase !== 'expired' && qr.phase !== 'error' && qr.phase !== 'already_bound' && (
          <>
            <div style={styles.hint}>
              用微信扫码，把这个机器人绑定到你的个人微信。扫码后可能出现数字校验，按手机提示输入即可。
            </div>
            <div style={styles.qr} dangerouslySetInnerHTML={{ __html: qr.svg }} />
          </>
        )}

        {!status?.loggedIn && (qr?.phase === 'need_verifycode') && (
          <div style={styles.row}>
            <input style={styles.input} value={code} inputMode="numeric" placeholder="手机上的数字"
              onChange={event => setCode(event.target.value)} />
            <button style={styles.button} onClick={() => void act('/agent-wechat/api/verify-code', { code })}>提交</button>
          </div>
        )}

        {!status?.loggedIn && (qr?.phase === 'expired' || qr?.phase === 'error' || qr?.phase === 'already_bound') && (
          <div style={styles.row}>
            <button style={styles.button} onClick={() => void act('/agent-wechat/api/relogin')}>重新获取二维码</button>
          </div>
        )}

        {qr?.error && qr.phase !== 'waiting' && <div style={{ ...styles.hint, color: '#c62828' }}>{qr.error}</div>}

        {status?.loggedIn && (
          <>
            <div style={styles.hint}>
              机器人 ID：<span style={styles.mono}>{status.botId || '—'}</span><br />
              扫码用户 ID（填到策略的 allowed 里）：<span style={styles.mono}>{status.userId || '—'}</span><br />
              长轮询：{status.polling ? '运行中' : '已停止'}
              {status.lastPollAt ? `，最近一次 ${status.lastPollAt}` : ''}
            </div>
            {status.error && <div style={{ ...styles.hint, color: '#c62828' }}>{status.error}</div>}
            <div style={styles.row}>
              <button style={styles.button} onClick={() => void act('/agent-wechat/api/relogin')}>重新登录</button>
              <button style={styles.button} onClick={() => void act('/agent-wechat/api/logout')}>退出登录</button>
            </div>
          </>
        )}

        {notice && <div style={{ ...styles.hint, color: '#c62828' }}>{notice}</div>}
      </div>

      <div style={styles.card}>
        <span style={styles.title}>怎么用</span>
        <div style={styles.hint}>
          1. 扫码后在微信「我 → 设置 → 插件 → 微信ClawBot」里找到这个机器人，点进去扫描连接。<br />
          2. 直接发消息就行，比如「修一下登录页的错别字」；主控按接单规则判断是否建单。<br />
          3. 建单时回一条接单确认，跑完再把结果回帖到同一个对话。<br />
          4. superagent 需要先配好 GitHub 仓库和 gh 登录，否则工单不会执行。<br />
          5. 连续给同一个人发满 10 条会被微信拦下，等你再发一条消息才恢复；本插件按此计数。
        </div>
      </div>
    </div>
  )
}
