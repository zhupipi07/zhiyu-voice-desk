"""Link this project's original browser frames to the contemporaneous stereo recording and event log."""
import argparse
import hashlib
import json
import math
import struct
import wave
from pathlib import Path

from PIL import Image, ImageChops, ImageStat


def read(path):
    return json.loads(path.read_text(encoding="utf-8-sig"))


def trace_at(conn, clock):
    turns = conn["turns"]
    transcripts = [(t["markersMs"]["transcript"], t["transcript"]) for t in turns
                   if t.get("transcript") and t["markersMs"].get("transcript") is not None]
    tools = [(e["atMs"], {"name": e["name"], "ok": e["result"].get("ok")}) for t in turns
             for e in t["tools"] if e.get("atMs") is not None]
    replies = conn["opening"] + [r for t in turns for r in t["replies"]]
    audible = [r["id"] for r in replies if r.get("firstSoundMs") is not None and
               r.get("lastSoundMs") is not None and r["firstSoundMs"] <= clock <= r["lastSoundMs"]]

    def latest(events):
        eligible = [e for e in events if e[0] <= clock]
        return max(eligible, key=lambda e:e[0])[1] if eligible else None

    return {"last_completed_transcript": latest(transcripts), "last_tool": latest(tools),
            "reply_sound_envelopes": audible}


def levels(recording, origin, clock):
    # Previous 200 ms only. Times before or beyond the recording have no observation.
    end = round((clock - origin) * recording.getframerate() / 1000)
    if end <= 0 or end > recording.getnframes():
        return None
    start = max(0, end - recording.getframerate() // 5)
    recording.setpos(start)
    samples = list(struct.iter_unpack("<hh", recording.readframes(end - start)))
    def dbfs(values):
        energy = sum(v*v for v in values) / len(values)
        return round(10 * math.log10(energy / 32768**2), 2) if energy else None
    left, right = zip(*samples)
    return {"samples_per_channel":len(samples),"merchant_rms_dbfs":dbfs(left),"agent_rms_dbfs":dbfs(right)}


def analyze(root):
    manifest = read(root / "test_set" / "capture.json")
    folder = root / "test_set" / "images"
    rows = manifest["frames"]
    names = [r["name"] for r in rows]
    if any(Path(n).name != n for n in names) or len({Path(n).stem.casefold() for n in names}) != len(names):
        raise ValueError("Invalid or duplicate image stem")
    if {p.name for p in folder.iterdir() if p.is_file()} != set(names):
        raise ValueError("Image set does not match the capture manifest")
    evidence = root / "data" / "competition-upgrade"
    call = manifest["call"]
    report = read(evidence / (call + ".json"))
    conn, = report["connections"]
    if conn["connection"] != manifest["connection"] or report["call"] != call:
        raise ValueError("Mismatched connection")
    wav = evidence / (call + "-" + conn["connection"] + ".wav")
    if hashlib.sha256(wav.read_bytes()).hexdigest() != manifest["recording_sha256"]:
        raise ValueError("Stereo recording differs from the capture")
    with wave.open(str(wav), "rb") as recording:
        if (recording.getframerate(),recording.getnchannels(),recording.getsampwidth(),recording.getnframes()) != (8000,2,2,conn["recording"]["samples"]):
            raise ValueError("Unexpected recording format or length")
        previous = None
        last_clock = -1
        for row in rows:
            name = row["name"]
            image = folder / name
            digest = hashlib.sha256(image.read_bytes()).hexdigest()
            if digest != row["sha256"]:
                raise ValueError("Unexpected image bytes: " + name)
            with Image.open(image) as im:
                width, height = im.size
                small = im.convert("L").resize((32,24), Image.Resampling.BOX)
            difference = None if previous is None else round(ImageStat.Stat(ImageChops.difference(previous, small)).mean[0], 2)
            previous = small
            clock = row["ms"]
            result = {"image":name,"sha256":digest,"width_px":width,"height_px":height,
                      "mean_gray_change_0_to_255":difference,"call":call,"connection":conn["connection"],
                      "capture_kind":row["kind"],"audio_clock_ms":clock}
            if row["kind"] == "timed_frame":
                if not isinstance(clock,(int,float)) or not math.isfinite(clock) or clock < last_clock:
                    raise ValueError("Unordered frame clock: " + name)
                last_clock = clock
                result["events_as_of_frame"] = trace_at(conn,clock)
                result["audio_before_frame"] = levels(recording,conn["recording"]["originMs"],clock)
            elif row["kind"] == "result_page" and clock is None:
                quality = report["quality"]
                result["final_outcome"] = {"closed_loop":quality["closedLoop"],"materials":quality["materials"],
                                           "confirmation":(quality.get("confirmation") or {}).get("text"),
                                           "simulated_receipt":(report.get("receipt") or {}).get("number")}
            else:
                raise ValueError("Unknown capture kind: " + name)
            yield Path(name).stem + ".json",result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root",type=Path,default=Path(__file__).resolve().parents[1])
    parser.add_argument("--out",type=Path,help="Defaults to ROOT/results")
    parser.add_argument("--verify",action="store_true",help="Compare every regenerated object without writing")
    args = parser.parse_args()
    folder = args.out if args.out is not None else args.root / "results"
    rows = dict(analyze(args.root))
    if args.verify:
        if {p.name for p in folder.iterdir() if p.is_file()} != set(rows):
            raise ValueError("Result names differ from input stems")
        for name,obj in rows.items():
            if read(folder / name) != obj:
                raise ValueError("Result mismatch: " + name)
    else:
        if folder.exists() and any(folder.iterdir()):
            parser.error("Output directory must be empty. Use --verify for existing results.")
        folder.mkdir(parents=True,exist_ok=True)
        for name,obj in rows.items():
            (folder / name).write_text(json.dumps(obj,ensure_ascii=False,indent=2)+"\n", encoding="utf-8")
    print(f"{len(rows)} image / JSON pairs " + ("verified" if args.verify else "written"))


if __name__ == "__main__":
    main()
