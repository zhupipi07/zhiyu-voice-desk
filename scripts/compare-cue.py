"""Make short listening comparisons from a review pack with known synthetic inputs."""
import argparse
import html
import json
from pathlib import Path
import wave


def load(path):
    return json.loads(path.read_text(encoding="utf-8-sig"))


def make_clip(folder, call, sample):
    report = load(folder / (call + ".json"))
    connection = report["connections"][0]["connection"]
    source = folder / (call + "-" + connection + ".wav")
    name = call[:8] + "-question.wav"
    with wave.open(str(source), "rb") as src, wave.open(str(folder / name), "wb") as dst:
        rate = src.getframerate()
        assert rate == 8000 and src.getnchannels() == 2
        start = max(0, sample["left"]["start"] - rate // 4)
        end = min(src.getnframes(), sample["right"]["start"] + 3 * rate)
        src.setpos(start)
        dst.setparams(src.getparams())
        dst.writeframes(src.readframes(end - start))
    return name


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("folder", type=Path)
    parser.add_argument("--question", default="请问具体要补哪一页？")
    args = parser.parse_args()
    rows = []
    for detail in load(args.folder / "summary.json")["details"]:
        probe = detail.get("probe") or {}
        if "listenerCue" not in probe or not detail.get("reference"):
            continue
        call = detail["call"]
        alignment = load(args.folder / (call + "-reference.json"))
        sample = next((r for r in alignment["rows"] if r["input"] == args.question), None)
        if sample is None:
            continue
        row = {"call":call,"enabled":probe["listenerCue"],"injectedDelayMs":probe.get("injectedDelayMs",0),
               "question":args.question,"closedLoop":detail["closedLoop"],
               "cueGapMs":sample.get("cueGapMs"),"bodyGapMs":sample.get("gapMs")}
        turns = load(args.folder / (call + ".json"))["connections"][0]["turns"]
        row["cueObserved"] = any(t["turn"] == sample["turn"] and "listener_cue" in t["markersMs"] for t in turns)
        if row["bodyGapMs"] is not None:
            row["clip"] = make_clip(args.folder,call,sample)
        rows.append(row)
    if not rows:
        parser.error("No matching calls with reference alignment")
    rows.sort(key=lambda r:(-r["injectedDelayMs"],r["enabled"],r["call"]))
    markup = []
    for row in rows:
        def seconds(value):
            return "待复核" if value is None else f"{value/1000:.3f} 秒"
        cue = seconds(row["cueGapMs"]) if row["cueObserved"] else "未播放"
        condition = f'识别额外等待 {row["injectedDelayMs"]} 毫秒' if row["injectedDelayMs"] else '原速识别'
        setting = '开启' if row["enabled"] else '关闭'
        audio = f'<audio controls preload="metadata" src="{row["clip"]}"></audio>' if row.get("clip") else '原句对齐待核实'
        markup.append(f'<section><h2>{condition} · 短回应{setting}</h2><p>停语至“嗯” <b>{cue}</b>　停语至正文 <b>{seconds(row["bodyGapMs"])}</b></p>{audio}<p><a href="{row["call"]}.json">通话 {row["call"][:8]} 的原始记录</a></p></section>')
    page = '''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>短回应开关对照</title><style>
body{max-width:840px;padding:22px;margin:3vh auto;color:#18392e;font:16px/1.7 system-ui,"Microsoft YaHei",sans-serif}h1{margin:0}h2{font-size:19px}section{border-top:1px solid #a8c2b3;padding:8px 0}audio{width:min(100%,550px)}b,a{color:#155c44}small{color:#516459}</style><main><h1>短回应开关对照</h1>'''
    page += f'<p>同一商家录音“{html.escape(args.question)}”。依次播放，听问题结束后第一声回应和正文分别何时出现。所有片段来自各通原始双声道录音。</p>'
    page += '<p><small>受控组仅在测试探针中给真实识别结果增加所示的固定等待。两类间隔均以干净原句与回录的声学对齐测量，正式首字仍待人工标注。</small></p>'
    (args.folder / "对照回听.html").write_text(page+"".join(markup)+'</main></html>',encoding="utf-8")
    (args.folder / "cue-comparison.json").write_text(json.dumps(rows,ensure_ascii=False,indent=2),encoding="utf-8")
    print(json.dumps(rows,ensure_ascii=False))


if __name__ == "__main__":
    main()
