/**
 * TaskWatch — background-task watchboard for the Hermes desktop app.
 *
 * v0.2: the roster is ALL-SESSIONS by default — every live chat's background
 * processes in one pane, grouped by conversation, with a filter to the
 * focused chat. v0.1 behaviour (focused chat only) remains as the "focused"
 * mode. Each row still shows command, runtime, output tail, a silence
 * heartbeat and OS notifications; the chip now counts every session's
 * running tasks and its silence state is global.
 *
 * Data source: the gateway's own session.list + process.list session RPCs —
 * the same projections the desktop app renders. No network, no model calls,
 * nothing leaves the machine. Stop/kill goes through the gateway's
 * process.kill verb and only ever reaches processes a chat owns.
 *
 * Install (catalog package — desktop half auto-copied by the Electron shell):
 *   plugins/taskwatch/desktop/plugin.js  ->  desktop-plugins/taskwatch/plugin.js
 * (standalone install: put the file straight into desktop-plugins/taskwatch/)
 *
 * Plain ESM, loaded uncompiled — UI is jsx() calls, not JSX syntax.
 * Only these imports resolve: @hermes/plugin-sdk, react, react/jsx-runtime.
 */

import {
  cn, host, Tip, usePluginI18n, useQuery, useValue,
} from '@hermes/plugin-sdk'
import { useEffect, useRef, useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const ID = 'taskwatch'
const POLL_MS = 4000
const DEFAULT_SILENCE_MIN = 10
const TAIL_SIG_CHARS = 200          // tail slice compared across polls as the activity signature
const MAX_SESSION_FANOUT = 50       // cap of live sessions polled per refresh
const EXITED_KEEP_PER_CHAT = 5      // exited rows shown per conversation

// Registration context (for ctx.os.notify from poll callbacks) and the
// silence tracker. Module-level on purpose: survives pane remounts, resets on
// app restart (notifications simply re-baseline).
let _ctx = null
let _thresholdMin = DEFAULT_SILENCE_MIN
const _watch = new Map()            // process_id -> { sig, silentSince, notifiedSilent, exitNotified }

function shortCmd(command) {
  const one = String(command || '').replace(/\s+/g, ' ').trim()
  return one.length > 56 ? one.slice(0, 55) + '…' : one
}

function lastLine(tail) {
  const lines = String(tail || '').replace(/\r/g, '').split('\n').filter((l) => l.trim())
  const line = lines.length ? lines[lines.length - 1].trim() : ''
  return line.length > 96 ? line.slice(0, 95) + '…' : line
}

function fmtDuration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`
  if (m > 0) return `${m}m ${String(sec).padStart(2, '0')}s`
  return `${sec}s`
}

// One process' silence/exit state machine. Returns the notification kind when
// one should fire; the caller does the actual notifying.
function track(p, thresholdMin) {
  const now = Date.now()
  let w = _watch.get(p.session_id) || {}
  const sig = String(p.output_tail || '').slice(-TAIL_SIG_CHARS)
  const kind = { silentMin: 0 }

  if (p.status === 'exited') {
    if (!w.exitNotified) {
      w.exitNotified = true
      w.silentSince = null
      w.notifiedSilent = false
      kind.exit = true
      kind.ok = p.exit_code === 0
    }
  } else {
    if (w.sig !== undefined && w.sig !== sig) {          // new output — reset silence
      w.silentSince = null
      w.notifiedSilent = false
    }
    if (w.sig !== undefined && w.sig === sig) {          // unchanged since last poll
      if (!w.silentSince) w.silentSince = now
      kind.silentMin = (now - w.silentSince) / 60000
      if (kind.silentMin >= thresholdMin && !w.notifiedSilent) {
        w.notifiedSilent = true
        kind.silentAlert = true
      }
    }
    w.sig = sig
  }
  _watch.set(p.session_id, w)
  return kind
}

function deliver(p, kind, t, title) {
  if (!_ctx || (!kind.exit && !kind.silentAlert)) return
  const name = shortCmd(p.command)
  const where = title || ''
  try {
    if (kind.exit) {
      const msg = kind.ok
        ? t('exitOk', { name, title: where })
        : t('exitFail', { name, title: where, code: String(p.exit_code ?? '?') })
      host.notify({ kind: kind.ok ? 'success' : 'warning', message: msg })
      _ctx.os.notify({ title: t('osExitTitle'), body: msg })
    } else {
      const min = String(Math.max(1, Math.round(kind.silentMin)))
      const msg = t('silentBody', { name, title: where, min })
      host.notify({ kind: 'warning', message: msg })
      _ctx.os.notify({ title: t('osSilentTitle'), body: msg })
    }
  } catch (err) {
    // Notifications are best-effort; never let one break polling.
    host.logs?.(`taskwatch notify failed: ${err && err.message}`)
  }
}

// Shared tracking pass: run on every aggregate refresh, from both the pane
// and the always-mounted chip so notifications fire even when the pane's tab
// is inactive. `track` is idempotent per poll (dup notifications are
// suppressed by the per-process flags in _watch).
function useTracking(rows, t) {
  useEffect(() => {
    for (const r of rows) deliver(r.p, track(r.p, _thresholdMin), t, r.title)
  }, [rows])  // eslint-disable-line react-hooks/exhaustive-deps
}

function StatusDot({ state }) {
  // state: 'running' | 'silent' | 'exited' — theme vars only, no hardcoded colors.
  const cls = state === 'running'
    ? 'bg-(--ui-accent)'
    : state === 'silent'
      ? 'bg-(--ui-accent) opacity-40'
      : 'bg-(--ui-text-quaternary)'
  return jsx('span', { className: cn('inline-block h-2 w-2 shrink-0 rounded-full', cls) })
}

function Row({ p, t, now, onKill, killing, expanded, onToggle }) {
  const running = p.status !== 'exited'
  const w = _watch.get(p.session_id)
  const silentMin = running && w && w.silentSince ? (now - w.silentSince) / 60000 : 0
  const state = !running ? 'exited' : silentMin >= 1 ? 'silent' : 'running'
  const startedMs = (p.started_epoch || 0) * 1000
  const runtime = running
    ? fmtDuration(now - startedMs)
    : p.exited_at
      ? fmtDuration((p.exited_at - p.started_at) * 1000)
      : '—'
  const line = lastLine(p.output_tail)
  const preRef = useRef(null)
  const feedRef = useRef(null)     // append-only feed: { seq, tailSeen, endsWithNl, atBottom }
  const [lines, setLines] = useState([])

  // Expand/collapse lifecycle: baseline the feed from the current tail on
  // expand, drop it on collapse.
  useEffect(() => {
    if (!expanded) {
      feedRef.current = null
      setLines([])
      return
    }
    const raw = String(p.output_tail || '').replace(/\r/g, '')
    // A trailing terminator is closure, not a line — keep it out of the feed
    // or the next append lands after a phantom blank line.
    let arr = raw === '' ? [] : raw.split('\n')
    if (raw.endsWith('\n') && arr.length > 0) arr = arr.slice(0, -1)
    feedRef.current = { seq: arr.length, tailSeen: raw, endsWithNl: raw.endsWith('\n'), atBottom: true }
    setLines(arr.map((text, i) => ({ seq: i, text })))
  }, [expanded])  // eslint-disable-line react-hooks/exhaustive-deps

  // Ingest each poll: locate the previously seen tail inside the new one
  // (appends keep it as a substring; the window may also have rolled from the
  // front), then append ONLY the new lines. Stable per-line keys mean React
  // touches just the new line nodes — an expanded live view never re-wraps
  // the whole block, so scrolling stays smooth.
  useEffect(() => {
    if (!expanded || !feedRef.current) return
    const feed = feedRef.current
    const raw = String(p.output_tail || '').replace(/\r/g, '')
    if (raw === feed.tailSeen) return

    const needle = feed.tailSeen.slice(-256)
    const idx = needle ? raw.indexOf(needle) : 0
    let newContent = null
    let droppedLines = 0
    if (idx < 0) {
      // Diverged (more than the window arrived between polls): re-baseline.
      let arr = raw === '' ? [] : raw.split('\n')
      if (raw.endsWith('\n') && arr.length > 0) arr = arr.slice(0, -1)
      feed.tailSeen = raw
      feed.endsWithNl = raw.endsWith('\n')
      feed.seq = arr.length
      setLines(arr.map((text, i) => ({ seq: i, text })))
      return
    }
    const fullStart = idx - (feed.tailSeen.length - needle.length)
    if (fullStart >= 0 && raw.slice(fullStart, fullStart + feed.tailSeen.length) === feed.tailSeen) {
      newContent = raw.slice(fullStart + feed.tailSeen.length)
      droppedLines = fullStart > 0 ? raw.slice(0, fullStart).split('\n').length - 1 : 0
    } else {
      newContent = raw.slice(idx + needle.length)
      droppedLines = idx > 0 ? raw.slice(0, idx).split('\n').length - 1 : 0
    }
    const prevClosed = feed.endsWithNl
    feed.tailSeen = raw
    feed.endsWithNl = raw.endsWith('\n')

    setLines((prev) => {
      let list = prev
      if (droppedLines > 0) list = list.slice(Math.min(droppedLines, list.length))
      let parts = newContent.split('\n')
      if (raw.endsWith('\n')) parts = parts.slice(0, -1)     // trailing terminator, not a line
      if (parts.length === 1 && parts[0] === '') return list
      if (parts[0] === '' && !prevClosed) {
        parts = parts.slice(1)                               // terminator of the grown last line
      } else if (parts[0] === '' && prevClosed) {
        // keep: a genuine blank line
      }
      if (!prevClosed && parts.length > 0 && parts[0] !== '' && list.length > 0) {
        // previous tail ended mid-line: the first chunk completes that line
        const last = list[list.length - 1]
        list = [...list.slice(0, -1), { seq: last.seq, text: last.text + parts[0] }]
        parts = parts.slice(1)
      }
      const added = parts.map((text) => ({ seq: feed.seq++, text }))
      const merged = [...list, ...added]
      return merged.length > 1200 ? merged.slice(merged.length - 1000) : merged
    })
  }, [expanded, p.output_tail])  // eslint-disable-line react-hooks/exhaustive-deps

  // Terminal-style follow: stay glued to the bottom while the user sits
  // there; the moment they scroll up to read history, stop following.
  useEffect(() => {
    if (expanded && feedRef.current?.atBottom && preRef.current) {
      preRef.current.scrollTop = preRef.current.scrollHeight
    }
  }, [lines, expanded])

  return jsxs('div', {
    className: cn(
      'rounded-md border border-(--ui-stroke-secondary) p-2',
      killing && 'opacity-50'
    ),
    children: [
      jsxs('div', {
        className: cn(
          'flex items-center gap-2 rounded cursor-pointer transition-colors',
          'hover:bg-(--chrome-action-hover)'
        ),
        title: expanded ? t('collapse') : t('expand'),
        onClick: onToggle,
        children: [
          jsx('span', {
            className: 'shrink-0 text-[0.6875rem] text-(--ui-text-quaternary)',
            children: expanded ? '▾' : '▸',
          }),
          jsx(StatusDot, { state }),
          jsx('div', {
            className: 'min-w-0 flex-1 truncate font-mono text-xs',
            title: p.command,
            children: shortCmd(p.command),
          }),
          jsx('div', { className: 'shrink-0 text-[0.6875rem] text-(--ui-text-tertiary)', children: runtime }),
          running && jsx('button', {
            type: 'button',
            className: cn(
              'shrink-0 rounded px-1.5 py-0.5 text-[0.6875rem] transition-colors',
              'text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-foreground'
            ),
            onClick: (e) => { e.stopPropagation(); onKill() },
            children: t('stop'),
          }),
        ]}),
      jsxs('div', { className: 'mt-1 flex items-center gap-2 pl-4 text-[0.6875rem] text-(--ui-text-tertiary)', children: [
        jsx('span', { children:
          !running
            ? `${t('exited')}${p.exit_code != null ? ` · exit ${p.exit_code}` : ''}${p.completion_reason && p.completion_reason !== 'exited' ? ` · ${p.completion_reason}` : ''}`
            : silentMin >= 1
              ? t('silentFor', { min: String(Math.floor(silentMin)) })
              : t('active'),
        }),
      ]}),
      line && !expanded && jsx('div', {
        className: 'mt-1 truncate pl-4 font-mono text-[0.6875rem] text-(--ui-text-quaternary)',
        title: line,
        children: line,
      }),
      expanded && jsxs('div', { children: [
        jsx('div', { className: 'mt-2 pl-4 text-[0.6875rem] text-(--ui-text-quaternary)', children: t('tailTitle') }),
        jsx('div', {
          ref: preRef,
          className: cn(
            'mt-1 max-h-60 overflow-y-auto whitespace-pre-wrap break-words rounded',
            'border border-(--ui-stroke-secondary) p-2 font-mono text-[0.6875rem] leading-relaxed',
            'text-(--ui-text-secondary)'
          ),
          style: { contain: 'content' },
          onScroll: (e) => {
            const el = e.currentTarget
            const feed = feedRef.current
            if (feed) feed.atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 32
          },
          children: lines.length === 0
            ? jsx('div', { className: 'text-(--ui-text-quaternary)', children: t('noOutput') })
            : lines.map((l) => jsx('div', { children: l.text === '' ? '\u00a0' : l.text }, l.seq)),
        }),
      ]}),
    ],
  })
}

// All-sessions roster: live sessions -> each session's own process.list
// projection -> flat rows carrying their chat identity. A session that dies
// mid-poll simply contributes no rows (one dead chat must not blank the
// whole watchboard).
async function fetchAllRows() {
  const listing = await host.request('session.list', {})
  const sessions = (listing?.sessions ?? []).slice(0, MAX_SESSION_FANOUT)
  const results = await Promise.all(sessions.map(async (s) => {
    try {
      const r = await host.request('process.list', { session_id: s.session_id })
      return { s, processes: r?.processes ?? [] }
    } catch (err) {
      return { s, processes: [] }
    }
  }))
  const out = []
  for (const { s, processes } of results) {
    for (const p of processes) out.push({ p, chatId: s.session_id, title: s.title || '' })
  }
  return out
}

function groupRows(rows) {
  const groups = []
  const by = new Map()
  for (const r of rows) {
    if (!by.has(r.chatId)) {
      const g = { chatId: r.chatId, title: r.title, rows: [] }
      by.set(r.chatId, g)
      groups.push(g)
    }
    by.get(r.chatId).rows.push(r)
  }
  for (const g of groups) {
    const running = g.rows.filter((r) => r.p.status !== 'exited')
    const exited = g.rows
      .filter((r) => r.p.status === 'exited')
      .sort((a, b) => (b.p.exited_at || 0) - (a.p.exited_at || 0))
      .slice(0, EXITED_KEEP_PER_CHAT)
    g.rows = [...running, ...exited]
  }
  return groups.filter((g) => g.rows.length > 0)
}

function Pane() {
  const t = usePluginI18n(ID)
  const sessionId = useValue(host.state.focusedSessionId)
  const [thresholdMin, setThresholdMin] = useState(_thresholdMin)
  const [armingKill, setArmingKill] = useState(null)   // process id awaiting confirm
  const [expandedId, setExpandedId] = useState(null)   // process id with open output view
  const [mode, setMode] = useState('all')              // 'all' | 'focused'
  const [, forceTick] = useState(0)                    // re-render for heartbeat text aging

  const q = useQuery({
    queryKey: ['taskwatch-all'],
    queryFn: fetchAllRows,
    refetchInterval: POLL_MS,
  })
  const rows = q.data ?? []
  const now = Date.now()
  useTracking(rows, t)

  // Age the "silent Xm" labels between polls.
  useEffect(() => {
    const timer = setInterval(() => forceTick((n) => n + 1), 30000)
    return () => clearInterval(timer)
  }, [])

  const shown = mode === 'focused' ? rows.filter((r) => r.chatId === sessionId) : rows
  const groups = groupRows(shown)

  function setThreshold(min) {
    _thresholdMin = min
    setThresholdMin(min)
    try { _ctx.storage.set('thresholdMin', String(min)) } catch { /* persistence is best-effort */ }
  }

  async function kill(chatId, processId) {
    setArmingKill(null)
    try { await host.request('process.kill', { session_id: chatId, process_id: processId }) }
    catch (err) { host.notify({ kind: 'warning', message: `${t('stopFailed')}: ${err && err.message}` }) }
  }

  const modeBtn = (key, label) => jsx('button', {
    type: 'button',
    className: cn(
      'rounded px-1.5 py-0.5 text-[0.6875rem] transition-colors',
      mode === key
        ? 'bg-(--chrome-action-hover) text-foreground'
        : 'text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover)'
    ),
    onClick: () => setMode(key),
    children: label,
  })

  return jsxs('div', {
    className: 'flex h-full flex-col gap-2 p-3 text-sm',
    children: [
      jsxs('div', { className: 'flex items-center justify-between gap-2', children: [
        jsx('div', { className: 'shrink-0 font-medium', children: t('paneTitle') }),
        jsxs('div', { className: 'flex items-center gap-1', children: [
          modeBtn('all', t('modeAll')),
          modeBtn('focused', t('modeFocused')),
        ]}),
      ]}),

      jsxs('div', { className: 'flex items-center justify-end', children: [
        jsxs('label', { className: 'flex items-center gap-1 text-[0.6875rem] text-(--ui-text-tertiary)', children: [
          t('threshold'),
          jsx('select', {
            className: 'rounded border border-(--ui-stroke-secondary) bg-transparent px-1 py-0.5',
            value: String(thresholdMin),
            onChange: (e) => setThreshold(Number(e.target.value)),
            children: [5, 10, 20, 30].map((m) =>
              jsx('option', { value: String(m), children: `${m} min`, key: String(m) })),
          }),
        ]}),
      ]}),

      mode === 'focused' && !sessionId && jsx('div', { className: 'text-(--ui-text-tertiary)', children: t('noSession') }),

      q.isLoading && jsx('div', { className: 'text-(--ui-text-tertiary)', children: '…' }),

      !q.isLoading && q.error && jsx('div', {
        className: 'text-(--ui-text-tertiary)',
        children: t('error'),
      }),

      !q.error && !q.isLoading && groups.length === 0 && jsx('div', {
        className: 'text-(--ui-text-tertiary)',
        children: t('empty'),
      }),

      groups.map((g) => jsxs('div', { children: [
        mode === 'all' && jsxs('div', {
          className: 'mt-1 flex items-center justify-between gap-2 text-[0.6875rem] text-(--ui-text-quaternary)',
          children: [
            jsx('span', { className: 'truncate', title: g.title, children: g.title || t('untitled') }),
            jsx('span', { className: 'shrink-0', children: String(g.rows.filter((r) => r.p.status !== 'exited').length) }),
          ],
        }),
        g.rows.map((r) => jsx(Row, {
          p: r.p,
          t,
          now,
          killing: armingKill === r.p.session_id,
          expanded: expandedId === r.p.session_id,
          onToggle: () => setExpandedId((cur) => (cur === r.p.session_id ? null : r.p.session_id)),
          onKill: () => {
            if (armingKill === r.p.session_id) kill(r.chatId, r.p.session_id)
            else {
              setArmingKill(r.p.session_id)
              setTimeout(() => setArmingKill((cur) => (cur === r.p.session_id ? null : cur)), 3000)
            }
          },
        }, r.p.session_id)),
      ]}, g.chatId)),
    ],
  })
}

function Chip() {
  const t = usePluginI18n(ID)
  const q = useQuery({
    queryKey: ['taskwatch-all'],
    queryFn: fetchAllRows,
    refetchInterval: POLL_MS,
  })
  const rows = q.data ?? []
  useTracking(rows, t)   // keep notifications firing while the pane's tab is inactive
  const now = Date.now()
  const running = rows.filter((r) => r.p.status !== 'exited')
  const stuck = running.filter((r) => {
    const w = _watch.get(r.p.session_id)
    return w && w.silentSince && (now - w.silentSince) / 60000 >= _thresholdMin
  }).length

  if (running.length === 0) return null
  const reveal = () => {
    // Same gesture as the OMH status item: reveal the plugin's pane. Older
    // app builds without the API fall back to a toast instead of no-op.
    if (typeof host.revealPane === 'function') host.revealPane(`${ID}:pane`)
    else host.notify({ kind: 'info', message: stuck > 0 ? t('stuckChip', { n: String(stuck) }) : t('chipTip') })
  }
  return jsx(Tip, {
    label: t('chipTip'),
    children: jsx('button', {
      type: 'button',
      onClick: reveal,
      className: cn(
        'inline-flex h-full items-center gap-1 px-1.5 text-[0.6875rem] transition-colors',
        stuck > 0
          ? 'text-(--ui-accent)'
          : 'text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-foreground'
      ),
      children: t('chip', { n: String(running.length) }),
    }),
  })
}

export default {
  id: ID, // must match the folder name
  name: 'TaskWatch',
  register(ctx) {
    _ctx = ctx
    try {
      const saved = ctx.storage.get('thresholdMin')
      const n = Number(saved)
      if (Number.isFinite(n) && n > 0) _thresholdMin = n
    } catch { /* first run or storage unavailable — keep the default */ }

    ctx.i18n.register({
      en: {
        paneTitle: 'Background tasks',
        modeAll: 'All chats',
        modeFocused: 'This chat',
        untitled: '(untitled chat)',
        noSession: 'Open a chat to see its background tasks.',
        empty: 'No background tasks right now.',
        error: 'Could not read the process list.',
        running: 'running',
        exited: 'exited',
        active: 'outputting',
        expand: 'Click to expand output',
        collapse: 'Click to collapse output',
        noOutput: '(no output yet)',
        tailTitle: 'Live tail — most recent 32 KB (older lines roll out of the buffer)',
        silentFor: (a) => `silent ${a.min} min`,
        stop: 'stop',
        stopFailed: 'Stop failed',
        exitOk: (a) => `Finished${a.title ? ` (${a.title})` : ''}: ${a.name}`,
        exitFail: (a) => `Failed (exit ${a.code})${a.title ? ` (${a.title})` : ''}: ${a.name}`,
        osExitTitle: 'Background task finished',
        osSilentTitle: 'Background task silent',
        silentBody: (a) => `${a.name}${a.title ? ` (${a.title})` : ''} has had no output for ${a.min} min — possibly waiting for input or stuck.`,
        chipTip: 'Background task watch — click to open the watchboard',
        stuckChip: (a) => `${a.n} task(s) silent past threshold`,
        chip: (a) => `${a.n} running`,
        threshold: 'Silence',
      },
      zh: {
        paneTitle: '后台任务',
        modeAll: '全部会话',
        modeFocused: '当前会话',
        untitled: '（未命名会话）',
        noSession: '打开一个会话以查看它的后台任务。',
        empty: '当前没有后台任务。',
        error: '无法读取进程列表。',
        running: '运行中',
        exited: '已退出',
        active: '输出中',
        expand: '点击展开输出',
        collapse: '点击收起输出',
        noOutput: '（尚无输出）',
        tailTitle: '实时尾巴——最近 32 KB（更早内容随缓冲滚动淘汰）',
        silentFor: (a) => `已静默 ${a.min} 分钟`,
        stop: '停止',
        stopFailed: '终止失败',
        exitOk: (a) => `已完成${a.title ? `（${a.title}）` : ''}：${a.name}`,
        exitFail: (a) => `失败（退出码 ${a.code}）${a.title ? `（${a.title}）` : ''}：${a.name}`,
        osExitTitle: '后台任务结束',
        osSilentTitle: '后台任务静默',
        silentBody: (a) => `${a.name}${a.title ? `（${a.title}）` : ''} 已 ${a.min} 分钟无输出——可能在等待输入或已卡住。`,
        chipTip: '后台任务监视（点击打开看板）',
        stuckChip: (a) => `${a.n} 个任务静默超阈值`,
        chip: (a) => `${a.n} 个运行中`,
        threshold: '静默',
      },
    })

    // Watchboard pane — right side, stacks with other right-side panes.
    ctx.register({
      id: 'pane',
      area: 'panes',
      title: 'TaskWatch',
      data: { placement: 'right', width: '300px' },
      render: () => jsx(Pane, {}),
    })

    // Statusbar chip: global running count, hidden while idle.
    ctx.register({
      id: 'chip',
      area: 'statusBar.right',
      order: 130,
      render: () => jsx(Chip, {}),
    })
  },
}
