"""Produce independent ASR timestamp candidates for clean stereo calls. Never fill scored annotations."""
import argparse
import json
import re
import wave
from pathlib import Path

import numpy as np
from faster_whisper import WhisperModel
from scipy.signal import resample_poly

def clean(text):
    return re.sub(r"[^\u3400-\u9fffA-Za-z0-9]", "", text)

def align(model, samples, origin, start, end):
    first = max(0, int((start - origin) * 8))
    last = min(len(samples), int((end - origin) * 8))
    if last <= first:
        return []
    audio = resample_poly(samples[first:last].astype("float32") / 32768, 2, 1)
    segments, _ = model.transcribe(audio, language="zh", word_timestamps=True, beam_size=3,
                                   temperature=0, condition_on_previous_text=False)
    offset = origin + first / 8
    return [{"text": w.word, "startMs": round(offset + w.start * 1000, 1),
             "endMs": round(offset + w.end * 1000, 1), "prob": round(w.probability, 3)}
            for segment in segments for w in (segment.words or []) if clean(w.word)]

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("report", type=Path)
    parser.add_argument("model", help="local faster-whisper checkpoint directory")
    parser.add_argument("--out",required=True,type=Path)
    args = parser.parse_args()
    data = json.loads(args.report.read_text(encoding="utf-8-sig"))
    model = WhisperModel(args.model, device="cpu", compute_type="int8", local_files_only=True, cpu_threads=4)
    rows = []
    for c in data["connections"]:
        rec = c.get("recording")
        if not rec or not rec["samples"]:
            continue
        path = args.report.parent / (data["call"] + "-" + c["connection"] + ".wav")
        with wave.open(str(path)) as f:
            if (f.getnchannels(),f.getframerate(),f.getsampwidth(),f.getnframes()) != (2,8000,2,rec["samples"]):
                raise ValueError("WAV and connection do not match")
            pcm = np.frombuffer(f.readframes(f.getnframes()),dtype="<i2").reshape(-1,2)
        origin = rec["originMs"]
        previous = origin
        for t in c["turns"]:
            markers = t["markersMs"]
            stop = markers.get("speech_stopped",markers.get("committed"))
            reply = next((r for r in t["replies"] if r.get("text") and r.get("firstSoundMs") is not None),None)
            if stop is None or not reply:
                continue
            start = markers.get("speech_started",stop)
            merchant = align(model,pcm[:,0],origin,max(previous,start-5500),stop+300)
            customer_end = merchant[-1]["endMs"] if merchant else None
            first = reply["firstSoundMs"]
            agent = align(model,pcm[:,1],origin,first-450,min(first+5200,(reply.get("lastSoundMs") or first+5200)+300))
            agent_start = agent[0]["startMs"] if agent else None
            rows.append({"connection":c["connection"],"turn":t["turn"],"referenceMerchant":t.get("transcript"),
                         "referenceAgent":reply["text"],"merchantWords":merchant,"agentWords":agent,
                         "candidateGapMs":round(agent_start-customer_end) if customer_end and agent_start else None})
            previous = stop
    out = {"call":data["call"],"model":Path(args.model).name,"method":"faster-whisper CPU int8, independent left/right word timestamps; machine candidates only","turns":rows}
    with args.out.open("x",encoding="utf-8") as dest:
        json.dump(out,dest,ensure_ascii=False,indent=2)

if __name__ == "__main__":
    main()
