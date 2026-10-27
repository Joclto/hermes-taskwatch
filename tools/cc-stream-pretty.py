#!/usr/bin/env python3
"""cc-stream-pretty — turn Claude Code's stream-json into a human-readable feed.

Claude Code in print mode with `--output-format stream-json --verbose` emits
one JSON line per completed message/tool call, in real time. Piping that
through this filter renders a readable live stream that any terminal
watchboard (e.g. the TaskWatch pane) can display:

    claude -p "task" \
      --output-format stream-json --verbose \
      --dangerously-skip-permissions \
    | python cc-stream-pretty.py

Output lines:
    [think]  a completed thinking block (trimmed)
    [tool]   a tool call with a one-line input brief
    [result] a tool result (trimmed)
    [say]    assistant prose
    [done]   the final result with turns and cost

Stdlib only. Designed for `--include-partial-messages`-OFF: partial deltas
would flood a rolling tail; completed blocks land at a readable cadence.
"""
import json
import sys


def brief_input(inp):
    if not isinstance(inp, dict):
        return str(inp)
    for key in ("command", "file_path", "pattern", "query", "url", "path"):
        if inp.get(key):
            return str(inp[key])
    return str(inp)


def block_text(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(
            b.get("text", "") for b in content if isinstance(b, dict)
        )
    return str(content)


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            event = json.loads(line)
        except Exception:
            continue
        etype = event.get("type")

        if etype == "assistant":
            for block in (event.get("message") or {}).get("content") or []:
                if not isinstance(block, dict):
                    continue
                btype = block.get("type")
                if btype == "thinking":
                    text = " ".join((block.get("thinking") or "").split())
                    if text:
                        print(f"[think] {text[:200]}", flush=True)
                elif btype == "tool_use":
                    print(
                        f"[tool] {block.get('name')}: "
                        f"{brief_input(block.get('input'))[:160]}",
                        flush=True,
                    )
                elif btype == "text":
                    text = " ".join((block.get("text") or "").split())
                    if text:
                        print(f"[say] {text[:200]}", flush=True)

        elif etype == "user":
            for block in (event.get("message") or {}).get("content") or []:
                if isinstance(block, dict) and block.get("type") == "tool_result":
                    text = " ".join(block_text(block.get("content")).split())
                    if text:
                        print(f"[result] {text[:160]}", flush=True)

        elif etype == "result":
            result = " ".join(str(event.get("result") or "").split())
            cost = event.get("total_cost_usd") or 0
            print(
                f"[done] {result[:300]} "
                f"(turns: {event.get('num_turns')}, cost: ${cost:.4f})",
                flush=True,
            )


if __name__ == "__main__":
    main()
