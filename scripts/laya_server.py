"""Compatibility entry: fixed registered Laya service; no latest/hub fallback."""
import runpy
from pathlib import Path
if __name__ == "__main__":
    runpy.run_path(str(Path(__file__).resolve().parents[1] / "services/laya/server.py"), run_name="__main__")
