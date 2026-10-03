# 更新日志

每次改动递增版本号，发布包为仓库根目录的 `ClaudeCodeToaster-v<版本>.zip`。
本日志从 v1.0.2 开始记录；此前版本（1.0.0 / 1.0.1）未追溯。

## [1.0.4] - 2026-10-03

### 新增

- 新增本更新日志（CHANGELOG.md），此后每次改动随版本记录一条。

## [1.0.3] - 2026-10-02

### 修复

- 修复 simple 预设 success 音效尾音被切断的问题：改为只裁掉源文件 1.5s 机械前导、
  保留从敲击到结尾的完整自然衰减（3.5s），峰值归一 -1.5dBFS。
- `maxDuration` 默认值 3 秒 → 4 秒，完整覆盖 3.5s 铃声不再截断。

### 维护

- 清理旧版本安装缓存（1.0.0 / 1.0.1 / 1.0.2）。

## [1.0.2] - 2026-10-02

### 变更

- simple 预设的 success 音效换成真实烤面包机铃声录音（来源：YouTube 视频
  <https://www.youtube.com/watch?v=IoN9UsFh9-I>，作者声明注明出处即可免费使用），
  由 `toaster_sound/Toaster Oven Bell Ding.mp3` 裁切生成（44.1kHz / 单声道 / 16-bit PCM）。
- `scripts/generate-sounds.mjs`：真实录音改为只复制到 `dist/`、不重新合成，素材缺失时明确报错。
- README、`src/sounds/README.md`：同步素材来源与署名说明。
