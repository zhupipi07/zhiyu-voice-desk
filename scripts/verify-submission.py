"""Reproduce the image outputs, audio-reference latency and policy experiments in the submission ZIP."""
import json
import math
from pathlib import Path
import subprocess
import sys
import tempfile


def read(path):
    return json.loads(path.read_text(encoding="utf-8-sig"))


def main():
    root = Path(__file__).resolve().parents[1]
    def run(*args):
        return subprocess.check_output(args,cwd=root)
    print(run(sys.executable,"scripts/analyze-submission.py","--verify").decode().strip())
    for experiment in ("rsi","guidance","safety"):
        fresh = json.loads(run("node",f"scripts/evaluate-{experiment}.mjs"))
        if fresh != read(root / "docs" / "evidence" / (experiment+".json")):
            raise ValueError("Policy evaluation differs: "+experiment)
        print(experiment+": verified")
    reference = root / "data" / "competition-upgrade"
    summary = read(reference / "summary.json")
    with tempfile.TemporaryDirectory() as temp:
        values = []
        for d in summary["details"]:
            if not d.get("reference"):
                continue
            call = d["call"]
            output = Path(temp) / (call+".json")
            run(sys.executable,"scripts/reference-latency.py",str(reference/"summary.json"),"--call",call,"--out",str(output))
            fresh = read(output)["rows"]
            archived = read(reference / (call+"-reference.json"))["rows"]
            if [(r["turn"],r["gapMs"]) for r in fresh] != [(r["turn"],r["gapMs"]) for r in archived]:
                raise ValueError("Audio alignment differs: "+call)
            values.extend(r["gapMs"] for r in fresh if r["gapMs"] is not None)
        values.sort()
        result = (len(values),values[math.ceil(len(values)*.5)-1],values[math.ceil(len(values)*.95)-1])
        saved = summary["reference"]
        if result != (saved["n"],saved["p50Ms"],saved["p95Ms"]):
            raise ValueError("Aggregate audio alignment differs")
        print("Acoustic reference: n=%d, P50=%d ms, P95=%d ms" % result)


if __name__ == "__main__":
    main()
