# 上传版源码与结果复核

解压源码 ZIP，在含 `package.json` 的根目录运行。分析使用 Python 3.14 和 Node.js 24。随包提供测试输入、原始录音和日志，无需云凭据即可复核。仓库公开版提供算法源码，实测样本由参赛队在上传包中提供。

```powershell
python -m pip install -r requirements-analysis.txt
python scripts/verify-submission.py
```

验证程序从 153 张原图重新生成结构化对象，与 `results/` 中的 JSON 逐一比较；复跑两项 RSI 留出实验与合规对照；用干净的已知语句和原始双声道录音重算三通本机联测的参考间隔。预期有 10 轮通过对齐筛选，P50 为 1510 毫秒、P95 为 2401 毫秒。正式首字仍须人工听辨并按赛方口径复核。

## 图片测试集与字段

图片来自团队自建的同一次授权书通话测试。152 张 JPEG 是浏览器连续实录帧，最后一张是挂断后保存的办理结果页。商家使用合成普通话发言。图像用于定位和复核通话，业务输入为语音。帧时间为截图调用前记录的浏览器音频时钟，采集和渲染存在短暂时间差。结果页仅有挂断后的状态，时间值为 null。

- `test_set/images/` 保留原文件名，`test_set/capture.json` 登记通话、连接、帧时间、图像及录音 SHA-256。
- 每张图都对应 `results/<图像主文件名>.json`。图像尺寸和相邻图的灰度变化来自像素；已完成的转写、最近的业务工具、回复首尾声范围来自同连接日志。首尾声范围内可能存在停顿。
- `audio_before_frame` 从原始 WAV 取该帧之前最多 200 毫秒，分别计算商家和坐席的 RMS dBFS。录音范围外为 null，声道全静音的分贝值为 null。最终的确认和模拟回执只在结果页样本中写入。
- `data/competition-upgrade/index.html` 可回听 13 通开发联测，晚间的 4 通开关对照在 `data/competition-cue/index.html`。审核时可先打开录屏案卷 6954741f，或关闭短回应的原速案卷 00aeb8d0。

把逐图结果输出到新的空目录可运行 `python scripts/analyze-submission.py --out reproduced-results`。验证随包结果用 `python scripts/analyze-submission.py --verify`。源码运行与模型部署见 README.md 和 docs/REVIEW-GUIDE.md；`npm test` 执行工程回归，浏览器测试需要 Chrome 或 Edge。
