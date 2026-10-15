"""What AgentHydra's own pages cost the person reading them, in price check points.

The measure behind `pricecheck.own_pages.points` in .rsi/rsi.yaml: a static price check scan of this repo (Desk, the
HSwarm console, the orchestrator) summed over every page. The scan skips what the repo gitignores and reads no clock or
network, so two runs on one commit print the same number. A trial that changes pricecheck itself moves it too; judge
such a trial by pricecheck's own tests, not by this. Prints one JSON line.
"""
from __future__ import annotations

import json
import subprocess
from pathlib import Path

root = Path(__file__).resolve().parents[2]
out = subprocess.run(["bun", "pricecheck/bin/pricecheck.mjs", "scan", "--json"], cwd=root, capture_output=True,
                     text=True, encoding="utf-8", check=True).stdout
pages = json.loads(out)["pages"]
print(json.dumps({"points": sum(p["points"] for p in pages), "pages": len(pages)}))
