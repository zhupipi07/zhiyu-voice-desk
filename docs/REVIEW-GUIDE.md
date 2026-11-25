# 智语外呼评审与复现指南

## 现场演示

1. 打开启动脚本显示的本机网址，选 018，勾选保存双方语音。按测试者手卡核身，在第二项材料播报时问“具体要补哪一页”。观察“已播部分”、追问答复、补讲和商家确认，挂断后核对模拟回执。
2. 换 027 并报出新商家名，问“要交到哪里”。核对书面意见只出现本案的店名要求。另一次可要求“请转人工客服”，在结果页查人工任务单。
3. 选 035 执行书面办理；选 046 登记跟进，选择“记录二次未接”。对照各自的规则行、回执编号和外呼任务编号。已处理的同一审核版本再次打开时返回既有办理结果。
4. 打开队内评审包的 `data/competition-upgrade/index.html`，可离线定位转写、工具、声音和回执。标注首字时，暂停到商家最后一个字结束处与坐席第一个可辨字处，分别标记。导出本通标注 JSON，运行 `npm run eval:latency -- 文件.json`。打开另一份报告时，录音和标注均按通话、连接及轮次独立。

## 两条语音路径

| 入口 | 输入、决策和输出 | 部署条件 |
|---|---|---|
| `start.cmd` | 浏览器 WebRTC 至本机网关。Qwen-Audio-3.1-Realtime-Flash 识别发言并选择工具，后端按案卷核身和检索。已审核的固定答复可用本机语音播放。其他回复进入云端生成。默认网关在放行云端语音前检查整段转写。 | Node 24、项目依赖、浏览器、北京百炼 Key/Workspace、网络。可切换 `REVIEW_LOCAL_SPEECH=0` 和 `REVIEW_STRICT_AUDIO=0` 做云端流式对照。 |
| `start-local.cmd` | 浏览器 WebRTC 至本机网关。650 毫秒本地静音检测、常驻 Paraformer 中文识别、后端规则选择案卷工具、获准话术本地播报。语音不离开本机。 | Node 24、原生 WebRTC 依赖、系统普通话声音、FunASR Python 和权重。设置 `REVIEW_ASR_PYTHON`、`REVIEW_ASR_MODEL`。 |

本机离线路径使用 Python 3.12.10、FunASR 1.3.22、PyTorch/torchaudio 2.7.1、NumPy 1.26.4，CPU 四线程。Paraformer 中文 16 kHz、8404 词表权重的本机版本为 v2.0.5。迁移时可安装同系列依赖，把权重目录指向含 `model.pt`、`config.yaml`、词表和特征配置的本地目录。在 Windows“语言和区域”中安装中文语音后运行启动脚本。固定答复由 Windows System.Speech / Microsoft Huihui Desktop 逐句生成，文件按文本 SHA-256 索引，系统语音随 Windows 提供。评审包附生成程序和本批对齐用到的合成原句，系统语音引擎由 Windows 提供。FunASR 代码和所用模型卡标注 Apache 2.0。可选的词级时延复核使用 faster-whisper 1.2.1、CTranslate2 4.8.1 和本地 Whisper base；时间戳是第二个识别器的估计。[FunASR 与许可](https://github.com/modelscope/FunASR) · [模型卡](https://www.modelscope.cn/models/iic/speech_paraformer-large_asr_nat-zh-cn-16k-common-vocab8404-pytorch) · [faster-whisper](https://github.com/SYSTRAN/faster-whisper) · [Whisper](https://github.com/openai/whisper)

改案卷后重启，Windows 启动脚本自动补齐新增固定答复的语音。核身前的语音白名单限于安全开场和核身澄清。每份回执以“申请＋审核版本”去重。商家主动回电和请求转人工分别登记本地任务，工单编号可复核。协作材料应由队员按真实提交、测试和演示记录填写。参赛平台推荐状态、承诺书和沙箱账户由团队核对。

## 复核随包交付的时延数据

在项目根目录运行下列命令可重新对齐演示录音。输入为包内的双声道录音和该次试验实际使用的合成原句 WAV。脚本需要 NumPy 和 SciPy，输出使用新文件名。前后端语音组件和预训练模型的来源、版本与许可列在技术方案书第 3 页。

```powershell
python scripts/reference-latency.py data/competition-upgrade/summary.json --call 6954741f-b5a0-458b-ba21-5a2061612802 --out 录屏案卷复算.json
```

## 自测与复算

参赛运行默认关闭预录短回应，以商家停语至坐席正文起声作自测。复现历史听感实验时可将 `REVIEW_LISTENER_CUE` 显式设为 `1` 后重启，浏览器才会预载 0.259 秒的“嗯”。两次短回应至少间隔 8 秒，商家再说话或正文就绪时让出播放。它在双声道录音中单独标记。探针参数 `--asr-delay-ms 1200` 仅用于受控实验。赛方统一测量工具决定正式首字成绩。

包内 `data/competition-cue/对照回听.html` 逐段给出同一问题在两种设置下的原声。质检页面可分别标记坐席首个可辨字与正文首字；下载后用 `npm run eval:latency -- 文件.json` 得到两组结果。

```powershell
npm test
npm run eval:rsi
npm run eval:guidance
powershell -NoProfile -File scripts/prepare-speech.ps1 -TestInputs
```

复跑浏览器语音探针需要 `playwright-core` 和 Chrome/Edge。可另装在测试环境，再将 `PROBE_PLAYWRIGHT` 指向其 JS 入口，`CHROME_BIN` 可指定浏览器。探针启用真实 WebRTC，使用系统合成普通话扮演商家，持久化到新建的独立目录。未指定 `REVIEW_TRANSPORT=local` 时会使用百炼额度。以下两次运行分别记录安静输入和在商家发言片段混入可重复白噪声的输入。每次含识别失败、缺回复或未确认的轮次都保留。

```powershell
$env:REVIEW_TRANSPORT='local'
node --env-file=.env scripts/probe-call.mjs --case POP-DEMO-018
node --env-file=.env scripts/probe-call.mjs --case POP-DEMO-027 --snr 18
```

同一批录音比较设备、断句与传输方式时应固定其他变量。赛方给出的街道、车载、多人背景声和弱网条件需要另测。网关分片默认 100 毫秒，可通过 `REVIEW_BATCH_MS` 切换 60、100 或 200。云端 `local_vad` 使用本地端点并显式提交音频，`server_vad_750` 由百炼声学断句。转接、播放中打断与续讲均由后端状态和实际播放证据约束。[百炼音频分片与交互模式](https://help.aliyun.com/zh/model-studio/qwen-audio-realtime-user-guides)

汇集多通证据可执行 `node scripts/review-pack.mjs --out 新目录 通话A.json 通话B.json`，将同连接的双声道 WAV 放在各自 JSON 旁。离线页同时显示声学候选间隔和已标注首字时延，逐通 JSON 保留配置、用量、误断和播放来源。云账单、真人标注与企业未公开测试集可另与此基线核对。
