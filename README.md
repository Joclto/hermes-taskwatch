# TaskWatch

A background-task watchboard for the [Hermes Agent](https://github.com/NousResearch/hermes-agent) desktop app: every process your chat dispatches through `terminal(background=true)` — **claude, opencode, codex, zcode, a build, a test run, anything** — rendered as a live roster with output tail, runtime, a silence heartbeat and OS notifications.

> 你派出去的后台编码代理（cc / opencode / codex / 任何终端进程）在干什么、有没有卡死，一块面板看清。

## Why

Dispatching a coding agent in the background answers "is it running?" but not **"what is it doing, is it stuck, did it finish?"** — and each agent has its own transcript format. TaskWatch watches at the **terminal-process layer** instead: it renders the gateway's own `process.list` projection for the focused chat, so it is agent-agnostic by construction.

## Features

- **Live roster pane** — one row per background process: command, runtime, last output line, status dot
- **Silence heartbeat** — a running task whose output stops changing shows `silent N min`; configurable threshold (5/10/20/30 min)
- **OS notifications** — task goes silent past the threshold, or exits (success/failure by exit code) → native toast (fires while you are away from Hermes; in-app toast otherwise)
- **Stop button** — two-click confirm, goes through the gateway's `process.kill` verb and only reaches processes the focused chat owns
- **Expandable output** — click a row to expand a scrollable view of the most recent 32 KB of output (agent thinking included when the agent prints it to the terminal); mouse-wheel through it while the task keeps running
- **Status-bar chip** — running count, hidden while idle, highlighted when something is silent past the threshold; **click to reveal the pane** (same `host.revealPane` gesture as the OMH status item)
- **English + 中文**

## Install

1. Copy `desktop/plugin.js` into your Hermes desktop-plugins folder, named by the plugin id:

   ```
   <hermes home>/desktop-plugins/taskwatch/plugin.js
   ```

   (`%LOCALAPPDATA%\hermes\desktop-plugins\taskwatch\plugin.js` on Windows, `~/.hermes/desktop-plugins/taskwatch/plugin.js` by default otherwise.)

2. In the desktop app, run **Reload desktop plugins** from the command palette (⌘K / Ctrl+K). The pane appears on the right; drag it anywhere.

No build step, no dependencies, nothing to compile.

## How it works

- Data: the gateway's `process.list` session RPC — the same projection the desktop dock renders, scoped to the focused chat's own processes.
- Heartbeat: TaskWatch compares the process output tail between polls; an unchanged tail while the process is running means silence. Silence is a heuristic — a quiet build is not a stuck build — which is why it surfaces **"silent N min"** (possible wait-for-input or stall) rather than claiming failure.
- Notifications: in-app toast always; native OS toast (fired by the plugin, gated by Settings ▸ Notifications ▸ "Plugin notifications") so you hear about a stalled or finished task while working in another window.
- Stop: the gateway's `process.kill` session verb, which refuses any process the focused chat does not own.

**Privacy:** everything is local. The pane reads the process projection for the chat you focused; nothing is written, exported or sent anywhere; no model tokens are spent.

## Scope & roadmap

- v1 (this repo): focused-chat roster, silence heartbeat, exit notifications, stop.
- Candidate next: all-sessions roster (per profile), loop detection (same tool + same arguments repeated, as `hermes-monitor` does for kanban workers), click-through to the matching terminal tab, catalog submission.

## License

MIT — see [LICENSE](LICENSE).
