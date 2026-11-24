"""Record a two-turn Claude Code stream-json session, answering permission prompts as the host.

Usage: python3 tools/record_claude.py <sandbox_dir> <out.ndjson>
Every line read from or sent to Claude is logged with a direction prefix ("<" = from agent, ">" = to agent).
"""
import json
import subprocess
import sys

sandbox, out_path = sys.argv[1], sys.argv[2]
TURNS = [
    "Run `python3 -c 'import calc; print(calc.add(2,3))'` with Bash and tell me the output.",
    "Now add a `sub(a, b)` function to calc.py.",
]

proc = subprocess.Popen(
    ["claude", "-p", "--input-format", "stream-json", "--output-format", "stream-json",
     "--verbose", "--include-partial-messages", "--permission-prompts", "host", "--permission-prompt-tool", "stdio"],
    cwd=sandbox, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1,
)
log = open(out_path, "w")


def send(msg):
    line = json.dumps(msg)
    log.write("> " + line + "\n")
    proc.stdin.write(line + "\n")
    proc.stdin.flush()


def user(text):
    send({"type": "user", "message": {"role": "user", "content": text}})


send({"type": "control_request", "request_id": "init-1", "request": {"subtype": "initialize"}})
user(TURNS[0])
turn = 0
for raw in proc.stdout:
    log.write("< " + raw)
    ev = json.loads(raw)
    if ev.get("type") == "control_request" and ev["request"].get("subtype") == "can_use_tool":
        req = ev["request"]
        print("PERMISSION", req.get("tool_name"), json.dumps(req.get("input"))[:100], file=sys.stderr)
        send({"type": "control_response", "response": {
            "subtype": "success", "request_id": ev["request_id"],
            "response": {"behavior": "allow", "updatedInput": req.get("input", {})}}})
    elif ev.get("type") == "result":
        turn += 1
        print("RESULT turn", turn, ev.get("subtype"), ev.get("total_cost_usd"), file=sys.stderr)
        if turn < len(TURNS):
            user(TURNS[turn])
        else:
            proc.stdin.close()
proc.wait()
log.close()
