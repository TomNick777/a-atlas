"""Owned-process CLI for the unified application and private Laya lifecycle."""
from __future__ import annotations
import argparse
from contextlib import contextmanager
import json
import os
import subprocess
import secrets
import socket
import sys
import time
import urllib.request
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "training/laya"))
from artifacts import atomic_json, model_path, registry, sha
STATE = ROOT / ".local/runtime"
LAYA_PYTHON = ROOT / ".venv-laya/Scripts/python.exe"
DATA_PYTHON = ROOT / ".venv/Scripts/python.exe"
PS_UTF8 = "[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); "

@contextmanager
def runtime_lock(timeout=10):
    STATE.mkdir(parents=True, exist_ok=True)
    handle = (STATE / "control.lock").open("a+b")
    if handle.tell() == 0:
        handle.write(b"0"); handle.flush()
    handle.seek(0)
    deadline = time.monotonic() + timeout
    while True:
        try:
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            break
        except OSError:
            if time.monotonic() >= deadline:
                handle.close()
                raise RuntimeError("Another runtime operation is in progress")
            time.sleep(0.1)
    try:
        yield
    finally:
        handle.seek(0)
        if os.name == "nt":
            msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            fcntl.flock(handle, fcntl.LOCK_UN)
        handle.close()

def read_json(path):
    return json.loads(path.read_text(encoding="utf-8"))

def health(port, path="/health"):
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}{path}", timeout=3) as response:
            return json.load(response)
    except Exception:
        return None

def command_line(pid):
    if os.name == "nt":
        script = PS_UTF8 + f"Get-CimInstance Win32_Process -Filter 'ProcessId = {int(pid)}' | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress"
        output = subprocess.check_output(["powershell", "-NoProfile", "-Command", script], encoding="utf-8", timeout=15).strip()
        if not output:
            return ""
        command = json.loads(output).get("CommandLine")
        if not command:
            raise RuntimeError("Process exists but command-line ownership cannot be verified")
        return command
    return Path(f"/proc/{int(pid)}/cmdline").read_bytes().replace(b"\0", b" ").decode()

def owned(name):
    path = STATE / f"{name}.json"
    if not path.exists():
        return None
    row = read_json(path)
    try:
        actual = command_line(row["pid"])
    except (OSError, subprocess.CalledProcessError, subprocess.TimeoutExpired) as error:
        if os.name != "nt" and isinstance(error, FileNotFoundError):
            return None
        raise RuntimeError(f"Cannot verify PID ownership for {name}") from error
    if not actual:
        return None
    # PID alone is insufficient: persisted launch argument and absolute entry must match.
    if row["entry"].lower() not in actual.lower() or any(str(arg).lower() not in actual.lower() for arg in row["identityArgs"]):
        raise RuntimeError(f"PID ownership mismatch for {name}; refusing to stop")
    return row

def port_in_use(port):
    with socket.socket() as connection:
        connection.settimeout(0.5)
        return connection.connect_ex(("127.0.0.1", port)) == 0

def launch(name, command, entry, identity_args=(), port=None, env=None):
    if owned(name):
        raise RuntimeError(f"{name} already running")
    if port and port_in_use(port):
        raise RuntimeError(f"Port {port} is occupied; no takeover")
    STATE.mkdir(parents=True, exist_ok=True)
    stdout = (STATE / f"{name}.log").open("a", encoding="utf-8")
    stderr = (STATE / f"{name}.err").open("a", encoding="utf-8")
    environment = os.environ.copy()
    environment.update(env or {})
    token = secrets.token_hex(24) if name == "laya" else None
    if token:
        environment["ATLAS_RUNTIME_TOKEN"] = token
    process = subprocess.Popen([str(arg) for arg in command], cwd=ROOT, env=environment, stdout=stdout, stderr=stderr, creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
    stdout.close(); stderr.close()
    atomic_json(STATE / f"{name}.json", {"pid": process.pid, "entry": str(entry), "identityArgs": list(identity_args), "startedAt": time.time(), "command": [str(arg) for arg in command], "controlToken": token})
    return process

def wait_ready(name, port, service, path="/health", timeout=60):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if not owned(name):
            raise RuntimeError(f"{name} exited before readiness; inspect .local/runtime/{name}.err")
        result = health(port, path)
        if result:
            if result.get("service") != service or not result.get("ok"):
                raise RuntimeError(f"{name} health identity/readiness mismatch")
            return result
        time.sleep(0.5)
    raise RuntimeError(f"{name} readiness deadline exceeded")

def stop(name):
    row = owned(name)
    if not row:
        return
    sidecar = health(8787) if name == "laya" else None
    if sidecar and sidecar.get("service") == "a-atlas-laya" and sidecar.get("pid") == row["pid"] and row.get("controlToken"):
        request = urllib.request.Request("http://127.0.0.1:8787/control/drain", data=b"{}", headers={"x-runtime-token": row.get("controlToken", "")}, method="POST")
        with urllib.request.urlopen(request, timeout=30) as response:
            if not json.load(response).get("drained"):
                raise RuntimeError("Laya did not drain")
    if os.name == "nt":
        snapshot = json.loads(subprocess.check_output(["powershell", "-NoProfile", "-Command", PS_UTF8 + "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress"], encoding="utf-8", timeout=15))
        descendants = {int(row["pid"])}
        for _ in range(len(snapshot)):
            found = {int(p["ProcessId"]) for p in snapshot if int(p["ParentProcessId"]) in descendants}
            if found <= descendants:
                break
            descendants.update(found)
        for p in snapshot:
            if int(p["ProcessId"]) in descendants and row["entry"].lower() not in (p["CommandLine"] or "").lower() and "\\windows\\system32\\conhost.exe " not in (p["CommandLine"] or "").lower():
                raise RuntimeError("Owned process tree contains an unexpected command; refusing stop")
        child_ids = sorted(int(p["ProcessId"]) for p in snapshot if int(p["ProcessId"]) in descendants - {int(row["pid"])} and row["entry"].lower() in (p["CommandLine"] or "").lower()) + [int(row["pid"])]
        for pid in child_ids:
            subprocess.run(["powershell", "-NoProfile", "-Command", f"$taskProcess = Get-Process -Id {pid} -ErrorAction SilentlyContinue; if ($taskProcess) {{ Stop-Process -Id {pid} -ErrorAction Stop }}"], check=False)
    else:
        import signal
        os.kill(row["pid"], signal.SIGTERM)
    for _ in range(50):
        try:
            if not owned(name):
                return
        except RuntimeError:
            # Windows can briefly expose an exited PID without CommandLine.
            # Ownership was checked before termination; never issue another kill.
            # A persistent unverified/live PID still fails at the deadline.
            pass
        time.sleep(0.1)
    raise RuntimeError(f"{name} did not stop")

def serve(model_id=None):
    if any(owned(path.stem) for path in STATE.glob("train-*.json")):
        raise RuntimeError("Training owns the GPU; inference is unavailable until it releases resources")
    model_id = model_id or registry()["active"]
    path, row = model_path(model_id)
    entry = ROOT / "services/laya/server.py"
    process = launch("laya", [LAYA_PYTHON, "-u", entry, "--checkpoint", path, "--device", "cuda"], entry, [str(path)], 8787)
    deadline = time.monotonic() + 120
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError("Laya startup failed; inspect .local/runtime/laya.err")
        result = health(8787)
        if result:
            if result.get("service") != "a-atlas-laya" or not result.get("ok") or result.get("sha16") != row["sha256"][:16]:
                stop("laya")
                raise RuntimeError("Laya health identity mismatch")
            return result
        time.sleep(0.5)
    stop("laya")
    raise RuntimeError("Laya startup deadline exceeded")

def switch_model(target, rollback=False):
    if any(owned(path.stem) for path in STATE.glob("train-*.json")):
        raise RuntimeError("Training owns the GPU; model switch cannot proceed")
    models = registry()
    path, row = model_path(target)
    if not rollback:
        evaluation_path = row.get("qualification")
        if not evaluation_path:
            raise ValueError("Candidate has no complete qualification report")
        evaluation_file = (ROOT / evaluation_path).resolve()
        if not evaluation_file.is_relative_to((ROOT / "reports/laya-evaluation").resolve()) or sha(evaluation_file) != row.get("qualificationSha256"):
            raise ValueError("Qualification report integrity mismatch")
        evaluation = read_json(evaluation_file)
        if not evaluation.get("qualified") or evaluation["sha256"] != row["sha256"] or evaluation.get("artifactDigest") != row["artifactDigest"]:
            raise ValueError("Candidate failed qualification or identity changed")
    elif target not in [models["active"], *models["history"]]:
        raise ValueError("Rollback target was never active")
    previous = models["active"]
    stop("laya")  # Server stops accepting requests; failed in-flight calls degrade explicitly.
    try:
        result = serve(target)
        if not rollback and result.get("model") != evaluation.get("actualModel"):
            raise ValueError("Loaded capability adapter/configuration differs from qualification")
        if target != previous:
            models["history"].append(previous)
        models["models"][previous]["status"] = "inactive"
        models["models"][target]["status"] = "active"
        models["active"] = target
        atomic_json(ROOT / "models/registry.json", models)
        return result
    except BaseException:
        stop("laya")
        serve(previous)
        raise

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["doctor", "start", "stop", "serve", "status", "data", "train", "resume", "cancel", "evaluate", "promote", "rollback"])
    parser.add_argument("--provider", choices=["jev", "drex", "laya"], default="jev")
    parser.add_argument("--config"); parser.add_argument("--init"); parser.add_argument("--run")
    parser.add_argument("--mode", choices=["corpus", "legacy"]); parser.add_argument("--manifest")
    parser.add_argument("--candidate"); parser.add_argument("--to")
    parser.add_argument("--label")
    args = parser.parse_args()
    if args.command in ("train", "resume") and not any(value == "--provider" or value.startswith("--provider=") for value in sys.argv[1:]):
        parser.error("train/resume require --provider jev (switch and release inference) or --provider laya (wait for inference)")
    if args.command in ("train", "resume") and args.provider == "drex":
        parser.error("Drex is a discovery judge only; train/resume require jev or laya")
    if args.run and not args.run.replace("-", "").replace("_", "").isalnum():
        raise ValueError("Invalid run ID")
    if args.command in ("start", "stop", "serve", "train", "resume", "cancel", "evaluate", "promote", "rollback"):
        with runtime_lock():
            execute(args)
    else:
        execute(args)

def execute(args):
    if args.command == "doctor":
        probe = subprocess.run([LAYA_PYTHON, "-c", "import json,torch,laya; print(json.dumps({'torch':torch.__version__,'cuda':torch.cuda.is_available(),'gpu':torch.cuda.get_device_name(0) if torch.cuda.is_available() else None}))"], capture_output=True, text=True, check=True)
        print(json.dumps({"root": str(ROOT), "dataPython": DATA_PYTHON.exists(), "laya": json.loads(probe.stdout), "active": registry()["active"], "services": {name: owned(name) is not None for name in ("web", "data", "laya")}}, ensure_ascii=False))
    elif args.command == "serve":
        print(json.dumps(serve()))
    elif args.command == "status":
        print(json.dumps({"registry": registry(), "health": health(8787), "queue": [read_json(p) for p in (STATE / "queue").glob("*.json")], "runs": [read_json(p) for p in (ROOT / "models/runs").glob("*/status.json")]}, ensure_ascii=False))
    elif args.command == "stop":
        for name in ("web", "laya", "data"):
            stop(name)
    elif args.command == "start":
        if not DATA_PYTHON.exists():
            raise RuntimeError("Data environment missing; create .venv and install services/stock-data/requirements.txt")
        started = []
        try:
            data = ROOT / "services/stock-data/server.py"
            launch("data", [DATA_PYTHON, "-u", data], data, port=8920, env={"ATLAS_DATA_PORT": "8920", "PYTHONUTF8": "1"})
            started.append("data"); wait_ready("data", 8920, "a-atlas-data")
            web = ROOT / "node_modules/next/dist/bin/next"
            no_proxy = ",".join(filter(None, (os.environ.get("NO_PROXY") or os.environ.get("no_proxy"), "127.0.0.1,localhost,::1")))
            launch("web", ["node", web, "start", "--port", "3400"], web, ["3400"], 3400, env={"ATLAS_JUDGE_PROVIDER": args.provider, "NODE_ENV": "production", "ATLAS_DATA_URL": "http://127.0.0.1:8920", "NODE_USE_ENV_PROXY": "1", "NO_PROXY": no_proxy})
            started.append("web"); wait_ready("web", 3400, "a-atlas-web", "/api/health")
            if args.provider == "laya":
                serve()
            print(json.dumps({"state": "ready", "provider": args.provider, "services": started + (["laya"] if args.provider == "laya" else [])}))
        except BaseException:
            for name in reversed(started):
                stop(name)
            raise
    elif args.command == "data":
        if not args.manifest or not args.mode:
            raise ValueError("data requires --mode and --manifest")
        subprocess.run([LAYA_PYTHON, ROOT / "training/laya/datasets/build.py", "--mode", args.mode, "--manifest", args.manifest], cwd=ROOT, check=True)
    elif args.command in ("train", "resume"):
        if not args.run:
            raise ValueError("Training requires a unique --run ID")
        training = any(owned(path.stem) for path in STATE.glob("train-*.json"))
        if args.command == "train":
            if not args.config or not args.init:
                raise ValueError("train requires --config and --init")
            args.config = str(Path(args.config).resolve())
            read_json(Path(args.config)); model_path(args.init)
            if (ROOT / "models/runs" / args.run).exists():
                raise ValueError("Run already exists; use resume")
        elif not (ROOT / "models/runs" / args.run / "resume.pt").exists():
            raise ValueError("Resume checkpoint missing")
        if args.provider == "laya" and (owned("laya") or health(8787) or training):
            queued = STATE / "queue" / f"{args.run}.json"
            if queued.exists():
                raise ValueError("Queue ID already exists")
            atomic_json(queued, {"state": "queued", "createdAt": time.time(), "reason": "GPU owned by inference or training", "arguments": vars(args), "configSha256": sha(Path(args.config)) if args.config else None})
            if not owned("queue-worker"):
                worker = ROOT / "scripts/laya_queue.py"
                launch("queue-worker", [sys.executable, "-u", worker], worker)
            print(json.dumps({"run": args.run, "state": "queued", "automaticStart": True}))
            return
        if training:
            raise RuntimeError("Another training process owns the GPU")
        if args.provider == "jev":
            stop("laya")
        if health(8787):
            raise RuntimeError("An external Laya process owns the GPU; training cannot take over")
        if args.provider == "jev":
            atomic_json(STATE / "judge-intent.json", {"schemaVersion": 1, "provider": "jev", "revision": str(time.time_ns()), "run": args.run})
        entry = ROOT / "training/laya/trainers/rlcd.py"
        command = [LAYA_PYTHON, "-u", entry, "--run", args.run]
        if args.command == "resume":
            (ROOT / "models/runs" / args.run / "cancel.request").unlink(missing_ok=True)
            command.append("--resume")
        else:
            if not args.config or not args.init:
                raise ValueError("train requires --config and --init")
            command += ["--config", str(Path(args.config).resolve()), "--init", args.init]
        launch(f"train-{args.run}", command, entry, [args.run])
        print(json.dumps({"run": args.run, "state": "launched", "provider": args.provider, "browserDirective": args.provider == "jev", "logs": str(STATE / f"train-{args.run}.log")}))
    elif args.command == "cancel":
        queued = STATE / "queue" / f"{args.run}.json"
        if queued.exists() and read_json(queued)["state"] == "queued":
            row = read_json(queued); row.update(state="cancelled", cancelledAt=time.time())
            atomic_json(queued, row)
            print(json.dumps({"run": args.run, "state": "cancelled", "started": False}))
            return
        path = ROOT / "models/runs" / str(args.run)
        if not path.resolve().is_relative_to((ROOT / "models/runs").resolve()) or not path.exists():
            raise ValueError("Unknown run")
        (path / "cancel.request").touch()
    elif args.command == "evaluate":
        if not args.candidate or not args.manifest:
            raise ValueError("evaluate requires --candidate and preregistered --manifest")
        command = [LAYA_PYTHON, ROOT / "training/laya/evaluation/evaluate.py", "--candidate", args.candidate, "--manifest", args.manifest]
        if args.label:
            command += ["--label", args.label]
        subprocess.run(command, cwd=ROOT, check=True)
    elif args.command in ("promote", "rollback"):
        print(json.dumps(switch_model(args.to if args.command == "rollback" else args.candidate, args.command == "rollback")))

if __name__ == "__main__":
    main()
