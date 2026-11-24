"""Record a two-turn Codex app-server (JSON-RPC over stdio) session, approving requests as the host.

Usage: python3 tools/record_codex.py <sandbox_dir> <out.ndjson>
Lines are logged with a direction prefix ("<" = from agent, ">" = to agent).
"""
import json
import os
import subprocess
import sys

sandbox, out_path = os.path.abspath(sys.argv[1]), sys.argv[2]
TURNS = [
    "Run `python3 -c 'import calc; print(calc.add(2,3))'` and tell me the output.",
    "Now add a `mul(a, b)` function to calc.py.",
]

proc = subprocess.Popen(["codex", "app-server"], cwd=sandbox, stdin=subprocess.PIPE,
                        stdout=subprocess.PIPE, text=True, bufsize=1)
log = open(out_path, "w")
next_id = 0
pending = {}  # request id -> method


def send(msg):
    line = json.dumps(msg)
    log.write("> " + line + "\n")
    proc.stdin.write(line + "\n")
    proc.stdin.flush()


def request(method, params):
    global next_id
    next_id += 1
    pending[next_id] = method
    send({"id": next_id, "method": method, "params": params})


def start_turn(thread_id, text):
    request("turn/start", {"threadId": thread_id,
                           "input": [{"type": "text", "text": text, "text_elements": []}]})


request("initialize", {"clientInfo": {"name": "agents-gui", "title": "agents-gui", "version": "0.0.0"},
                       "capabilities": None})
thread_id, turn = None, 0
for raw in proc.stdout:
    log.write("< " + raw)
    msg = json.loads(raw)
    if "id" in msg and ("result" in msg or "error" in msg):  # response to our request
        method = pending.pop(msg["id"], None)
        if "error" in msg:
            print("ERROR", method, msg["error"], file=sys.stderr)
            break
        if method == "initialize":
            send({"method": "initialized"})
            request("thread/start", {"cwd": sandbox, "model": os.environ.get("CODEX_MODEL"), "approvalPolicy": "untrusted",
                                     "sandbox": "workspace-write", "ephemeral": True})
        elif method == "thread/start":
            thread_id = msg["result"]["thread"]["id"]
            start_turn(thread_id, TURNS[0])
    elif "id" in msg and "method" in msg:  # server -> client request (approvals)
        print("SERVER REQUEST", msg["method"], json.dumps(msg.get("params"))[:120], file=sys.stderr)
        send({"id": msg["id"], "result": {"decision": "accept"}})
    elif msg.get("method") == "turn/completed":
        turn += 1
        print("TURN COMPLETED", turn, file=sys.stderr)
        if turn < len(TURNS):
            start_turn(thread_id, TURNS[turn])
        else:
            break
proc.terminate()
proc.wait()
log.close()
