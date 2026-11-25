"""Mux a probe --video series and its actual stereo WAV on the browser audio clock."""
import argparse
import json
import subprocess
from pathlib import Path

def read(path):
    return json.loads(path.read_text(encoding="utf-8-sig"))

def stamp(ms):
    cs=max(0,round(ms/10))
    return f"{cs//360000}:{cs//6000%60:02}:{cs//100%60:02}.{cs%100:02}"

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument("folder",type=Path)
    parser.add_argument("output",type=Path)
    args=parser.parse_args()
    folder=args.folder.resolve()
    meta=read(folder/"probe.json")
    report=read(folder/(meta["call"]+".json"))
    conn,=report["connections"]
    frames=read(folder/"frames.json")
    clip_end=conn["recording"]["originMs"]+conn["recording"]["samples"]/8
    last=max(clip_end,frames[-1]["ms"])
    with (folder/"film-frames.txt").open("w",encoding="utf-8") as f:
        for i,frame in enumerate(frames):
            end=frames[i+1]["ms"] if i+1<len(frames) else last
            if end<=frame["ms"]:continue
            f.write(f"file 'frames/{frame['name']}'\nduration {(end-frame['ms'])/1000:.4f}\n")
        f.write("file 'result.jpg'\nduration 4.5\nfile 'result.jpg'\n")
    subtitles=["[Script Info]","ScriptType: v4.00+","PlayResX: 1360","PlayResY: 1090","WrapStyle: 0",
      "[V4+ Styles]","Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding",
      "Style: Speech,Microsoft YaHei,29,&H00FFFFFF,&H00FFFFFF,&H001C2925,&H00000000,0,0,0,0,100,100,0,0,1,0,0,2,45,45,42,1",
      "Style: Label,Microsoft YaHei,18,&H00D3E8DD,&H00FFFFFF,&H001C2925,&H00000000,0,0,0,0,100,100,0,0,1,0,0,2,35,35,9,1",
      "[Events]","Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text"]
    def line(start,end,text,style="Speech"):
        if start is None or end is None or end<=start:return
        safe=text.replace("{","（").replace("}","）").replace("\\","")
        subtitles.append(f"Dialogue: 0,{stamp(start)},{stamp(end)},{style},,0,0,0,,{safe}")
    line(0,last+4500,("本机 Paraformer" if meta.get("transport")=="local" else "百炼网关")+"  ·  商家为合成语音  ·  真实 WebRTC 双声道回录","Label")
    def reply(r):
        if not r.get("text"):return
        line(r.get("firstSoundMs"),r.get("lastSoundMs"),"坐席　"+("本项播报被打断" if r["interrupted"] else r["text"]))
    for r in conn["opening"]:reply(r)
    for t in conn["turns"]:
        line(t.get("micStartCandidateMs"),t.get("micEndCandidateMs"),"商家　"+(t.get("transcript") or ""))
        for r in t["replies"]:reply(r)
    line(last,last+4500,"办理结果　"+("商家已确认，模拟回执已写入" if report["quality"]["closedLoop"] else "待跟进事项见结果页"))
    (folder/"film.ass").write_text("\n".join(subtitles),encoding="utf-8-sig")
    wav=meta["call"]+"-"+conn["connection"]+".wav"
    subprocess.run(["ffmpeg","-nostdin","-n","-v","error","-f","concat","-safe","0","-i","film-frames.txt",
      "-i",wav,"-vf","fps=15,pad=1360:1090:0:0:color=0x192d26,ass=film.ass",
      "-af",f"adelay={round(conn['recording']['originMs'])}:all=1,apad","-t",str(last/1000+4.5),"-c:v","libx264","-preset","fast",
      "-pix_fmt","yuv420p","-crf","23","-c:a","aac","-b:a","112k","-ar","44100","-movflags","+faststart",str(args.output.resolve())],cwd=folder,check=True)
if __name__=="__main__":
    main()
