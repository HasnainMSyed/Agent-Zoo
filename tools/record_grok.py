"""Record a two-turn Grok ACP session (`grok agent stdio`, JSON-RPC 2.0), approving permission requests.

Usage: python3 tools/record_grok.py <sandbox_dir> <out.ndjson>
Lines are logged with a direction prefix ("<" = from agent, ">" = to agent).
"""
import json
import os
import subprocess
import sys

sandbox, out_path = os.path.abspath(sys.argv[1]), sys.argv[2]
TURNS = [
    "Run `python3 -c 'import calc; print(calc.add(2,3))'` and tell me the output.",
    "Now add a `div(a, b)` function to calc.py.",
]

proc = subprocess.Popen(["grok", "agent", "stdio"], cwd=sandbox, stdin=subprocess.PIPE,
                        stdout=subprocess.PIPE, text=True, bufsize=1)
log = open(out_path, "w")
next_id = 0
pending = {}


def send(msg):
    msg = {"jsonrpc": "2.0", **msg}
    line = json.dumps(msg)
    log.write("> " + line + "\n")
    proc.stdin.write(line + "\n")
    proc.stdin.flush()


def request(method, params):
    global next_id
    next_id += 1
    pending[next_id] = method
    send({"id": next_id, "method": method, "params": params})


def prompt(session_id, text):
    request("session/prompt", {"sessionId": session_id, "prompt": [{"type": "text", "text": text}]})


request("initialize", {"protocolVersion": 1,
                       "clientCapabilities": {"fs": {"readTextFile": False, "writeTextFile": False},
                                              "terminal": False}})
session_id, turn = None, 0
for raw in proc.stdout:
    log.write("< " + raw)
    try:
        msg = json.loads(raw)
    except json.JSONDecodeError:
        print("NON-JSON", raw[:200], file=sys.stderr)
        continue
    if "id" in msg and ("result" in msg or "error" in msg):
        method = pending.pop(msg["id"], None)
        if "error" in msg:
            print("ERROR", method, msg["error"], file=sys.stderr)
            break
        if method == "initialize":
            print("INIT", json.dumps(msg["result"])[:300], file=sys.stderr)
            request("session/new", {"cwd": sandbox, "mcpServers": []})
        elif method == "session/new":
            session_id = msg["result"]["sessionId"]
            prompt(session_id, TURNS[0])
        elif method == "session/prompt":
            turn += 1
            print("TURN DONE", turn, msg["result"].get("stopReason"), file=sys.stderr)
            if turn < len(TURNS):
                prompt(session_id, TURNS[turn])
            else:
                break
    elif "id" in msg and "method" in msg:  # agent -> client request
        params = msg.get("params", {})
        print("AGENT REQUEST", msg["method"], json.dumps(params)[:160], file=sys.stderr)
        if msg["method"] == "session/request_permission":
            opts = params.get("options", [])
            pick = next((o for o in opts if o.get("kind") == "allow_once"), opts[0] if opts else None)
            send({"id": msg["id"], "result": {"outcome": {"outcome": "selected", "optionId": pick["optionId"]}}})
        else:
            send({"id": msg["id"], "error": {"code": -32601, "message": "not supported by recorder"}})
proc.terminate()
proc.wait()
log.close()
