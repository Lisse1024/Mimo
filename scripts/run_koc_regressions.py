from __future__ import annotations

import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
TESTS = [
    "scripts/test_koc_evidence_contract.py",
    "scripts/test_koc_work_fact_ledger.py",
    "scripts/test_koc_dynamic_script.py",
]


def main() -> None:
    for test in TESTS:
        print(f"running {test}")
        subprocess.run([sys.executable, test], cwd=ROOT, check=True)
    print("koc python regressions passed")


if __name__ == "__main__":
    main()
