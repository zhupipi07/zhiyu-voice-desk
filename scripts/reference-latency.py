"""Align the actual two-channel recording to the known clean synthetic speech; leave human labels untouched."""
import argparse
import hashlib
import json
import math
from pathlib import Path

import numpy as np
from scipy.io import wavfile
from scipy.signal import correlate, resample_poly

def locate(channel, path, lo, hi):
    rate, ref = wavfile.read(path)
    if ref.ndim != 1 or ref.dtype != np.int16:
        raise ValueError("Expected mono PCM16 reference")
    gcd = math.gcd(rate, 8000)
    ref = resample_poly(ref.astype(float), 8000 // gcd, rate // gcd)
    energy = np.sqrt(np.mean(ref[:len(ref)//80*80].reshape(-1,80)**2,axis=1))
    active = np.flatnonzero(energy > max(65, energy.max() * 0.015))
    if len(active) < 5:
        return None
    trim = ref[active[0]*80:(active[-1]+1)*80]
    region = channel[lo:hi].astype(float)
    if len(region) < len(trim):
        return None
    dot = correlate(region, trim, mode="valid", method="fft")
    integral = np.r_[0, np.cumsum(region**2)]
    sq = integral[len(trim):] - integral[:-len(trim)]
    norm = dot / np.sqrt(np.maximum(sq,1)*np.dot(trim,trim))
    index = int(np.argmax(norm))
    return {"start":int(lo+index),"end":int(lo+index+len(trim)),"ncc":round(float(norm[index]),3)}

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("probe",type=Path)
    parser.add_argument("--call", help="Look up one full call ID in an exported summary.json")
    parser.add_argument("--out",type=Path,required=True)
    args = parser.parse_args()
    meta = json.loads(args.probe.read_text(encoding="utf-8"))
    if args.call:
        entries = [d.get("probe") for d in meta.get("details", []) if d.get("call") == args.call]
        if len(entries) != 1 or not entries[0]:
            parser.error("This summary does not contain the original input index for that call")
        meta = entries[0]
    folder = args.probe.parent
    call = meta["call"]
    report = json.loads((folder/(call+".json")).read_text(encoding="utf-8"))
    turns = [(c,t) for c in report["connections"] for t in c["turns"]]
    inputs = meta.get("inputs",[])
    if len(inputs) != len(turns) or len(report["connections"])!=1:
        raise ValueError("Need one connection and an unambiguous pairing of sent inputs and recognized turns")
    conn = report["connections"][0]
    rate, pcm = wavfile.read(folder/(call+"-"+conn["connection"]+".wav"))
    if rate!=8000 or pcm.shape!=(conn["recording"]["samples"],2):
        raise ValueError("Recording format or duration mismatch")
    rows=[]
    origin = conn["recording"]["originMs"]
    for (_,turn), source in zip(turns,inputs):
        reply = next((r for r in turn["replies"] if r.get("text") and r.get("firstSoundMs") is not None),None)
        row={"turn":turn["turn"],"input":source["words"],"transcript":turn.get("transcript"),"gapMs":None}
        rows.append(row)
        if not reply or reply.get("audioSource")!="approved_local":
            continue
        key=hashlib.sha256(reply["text"].encode()).hexdigest()
        left=locate(pcm[:,0],Path("data/probe-inputs")/(source["key"]+".wav"),0,len(pcm))
        expected=int((reply["firstSoundMs"]-origin)*8)
        right=locate(pcm[:,1],Path("data/prompts")/(key+".wav"),max(0,expected-8000),min(len(pcm),expected+200000))
        row.update({"assistant":reply["text"],"left":left,"right":right})
        cue_time = turn["markersMs"].get("listener_cue")
        if cue_time is not None:
            near = round((cue_time-origin)*8)
            cue = locate(pcm[:,1],Path("public/listening.wav"),max(0,near-1600),min(len(pcm),near+6400))
            row["cue"] = cue
            if left and cue and min(left["ncc"],cue["ncc"]) >= 0.70 and abs(near-cue["start"]) <= 1600:
                row["cueGapMs"] = round((cue["start"]-left["end"])/8)
        if left and right and min(left["ncc"],right["ncc"])>=0.70 and abs(right["start"]-expected)<=1600:
            row["gapMs"]=round((right["start"]-left["end"])/8)
    result={"call":call,"method":"clean-reference-ncc-v1","scope":"合成音频参考对齐。以干净原句最后有声帧至坐席核准语句第一个有声帧估算；首字需听辨复核。","rows":rows}
    with args.out.open("x",encoding="utf-8") as out:
        json.dump(result,out,ensure_ascii=False,indent=2)
if __name__=="__main__":
    main()
