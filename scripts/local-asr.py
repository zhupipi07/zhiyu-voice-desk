"""Resident Mandarin Paraformer. stdin/stdout carry JSON lines with 16 kHz mono PCM."""
import base64
import contextlib
import json
import sys
from pathlib import Path

def send(value):
    print(json.dumps(value,ensure_ascii=True),flush=True)

def main():
    directory=Path(sys.argv[1]).resolve(strict=True)
    if not (directory/"model.pt").is_file():
        raise ValueError("Local Paraformer checkpoint is missing")
    with contextlib.redirect_stdout(sys.stderr):
        import numpy as np
        from funasr import AutoModel
        engine=AutoModel(model=str(directory),device="cpu",ncpu=4,disable_update=True,disable_pbar=True)
        engine.generate(input=np.zeros(16000,dtype=np.float32))
    send({"ready":True})
    for line in sys.stdin:
        request=json.loads(line)
        try:
            pcm=np.frombuffer(base64.b64decode(request["pcm"],validate=True),dtype="<i2")
            with contextlib.redirect_stdout(sys.stderr):
                result=engine.generate(input=pcm.astype(np.float32)/32768)
            send({"id":request["id"],"text":result[0].get("text","").strip()})
        except Exception as exc:
            send({"id":request["id"],"error":type(exc).__name__})
if __name__=="__main__":
    main()
