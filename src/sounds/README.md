# 默认音效目录说明（占位）

本目录**不直接存放二进制音频文件**，仅作为默认音效的说明与生成方式入口。

## 默认音效放在哪里

构建后，插件运行时实际加载的默认音效位于：

```
dist/sounds/<preset>/<status>.wav
```

仓库内保留的“源”音效位于：

```
assets/sounds/<preset>/<status>.wav
```

其中：

- `<preset>` 为预设包名：`simple`（简洁，默认）、`crisp`（清脆）、`tech`（科技风）
- `<status>` 为音效状态：`success`、`fail`、`abort`、`notify`（权限请求）

共 3 × 4 = 12 个 WAV 文件（44.1kHz / 单声道 / 16-bit PCM）。

其中 `simple/success.wav` 为**真实烤面包机铃声录音**（外部素材，来源与署名要求见仓库根 README「内置预设包」一节），
以源文件形式随仓库提交，构建时只复制到 `dist/`、不重新合成。其余 8 个为脚本合成。

## 生成方式

除 `simple/success.wav`（真实录音，只复制）外，默认音效由 Node.js 脚本数学合成
（正弦/方波 + 包络），**无任何第三方依赖、无音频素材版权问题**：

```bash
npm install        # 仅安装 TypeScript（devDependency）
npm run sounds     # 只生成音效
npm run build      # 编译 TypeScript 并自动生成音效
```

生成脚本：[`../../scripts/generate-sounds.mjs`](../../scripts/generate-sounds.mjs)

## 自定义音效（推荐方式，无需改本目录）

在 Claude Code 会话中使用斜杠命令：

```
/claudecode-toaster:sound set success C:\path\to\your.wav
/claudecode-toaster:sound set fail    /path/to/your.mp3
/claudecode-toaster:sound set abort   ~/sounds/abort.m4a
```

支持格式：**WAV / MP3 / M4A**。自定义文件缺失或损坏时会自动回退到本目录对应的内置预设，
内置预设也不可用时降级为终端蜂鸣（BEL / Console.Beep），绝不报错阻塞任务。
