# ClaudeCodeToaster 🍞🔔

Claude Code 终端插件：**bypass permissions 自动执行模式专属的任务完成音效提醒**。
任务结束（成功 / 失败 / 中断）时自动播放对应提示音，三类音效、音量、预设包全部可自定义，
让你不用紧盯终端——Claude 跑完活会"叮"你一声。

- 零运行时依赖：只用 Node.js 原生模块 + 系统自带播放器，**不安装任何第三方音频库**
- 跨平台：macOS / Windows / Linux，全部调用系统原生能力
- 异步非阻塞：音效在后台播放，绝不影响 Claude 主进程响应
- 任何损坏 / 缺失 / 播放器不可用都**静默降级**，绝不报错阻塞主任务
- TypeScript 编写，严格遵循 Claude Code 官方插件规范（已通过 `claude plugin validate`）

---

## 一、它是怎么工作的（钩子映射）

Claude Code 官方**没有** `task:complete` / `task:error` / `task:abort` 这三个钩子，
本插件按官方 [Hooks reference](https://code.claude.com/docs/en/hooks) 的真实生命周期事件做了如下映射：

| 任务状态 | 注册的官方钩子 | 触发判定逻辑 |
|---|---|---|
| **成功 success** | `Stop` | 主代理完成响应时触发；同时分析会话记录（transcript），若本轮最后一个工具结果是错误则改判 fail |
| **失败 fail** | `StopFailure` + `Stop` 的记录分析 | API 错误（限流 / 鉴权 / 计费 / 服务端，`StopFailure`）；工具执行失败后任务收尾（`Stop` + transcript 中最后一个 `tool_result.is_error === true`） |
| **中断 abort** | `PostToolUseFailure` | 仅当输入 `is_interrupt === true`（用户在工具执行期间按 Esc / Ctrl+C 终止）时播放；普通工具失败不响，避免每步打扰 |

其他关键行为：

- **默认仅在自动批准模式响**：钩子输入的 `permission_mode` 为 `bypassPermissions`
  （`--dangerously-skip-permissions`）或 `dontAsk` 时才播放；`default` / `plan` / `acceptEdits` / `auto` 模式静默。
  用 `/sound bypass-only` 可关闭该限制，做到所有模式都提醒。
- **一个任务只响一次**：`Stop` 是"每轮任务结束"事件（一轮 = 你发一次指令到 Claude 交还控制权），
  不会在每个工具调用后响；另有 **3 秒防抖**（同一 session + 状态 3 秒内只放一次）兜底。
- 三个钩子均配置为 `"async": true`，Claude 不等音效播完即可继续。
- 不注册 `SessionEnd`：正常 `/exit` 关闭终端不算"任务中断"，避免误导。

### 已知边界（官方限制，非 bug）

- Claude 在**纯文本生成阶段**被 Esc 中断时，官方不提供任何钩子（`Stop` 文档明确"用户中断时不触发"）。
  abort 音效覆盖的是**工具执行期间**的中断（长命令、测试、构建跑到一半被终止，这也是 bypass 模式下最常见的中断场景）。
- `StopFailure` 的钩子输入不带 `permission_mode`，此时按"宁报不漏"处理（fail-open），失败音一定会响。

---

## 二、目录结构

```
ClaudeCodeToaster/
├── .claude-plugin/
│   ├── plugin.json          # 插件清单（名称 / 版本 / 组件声明）
│   └── marketplace.json     # 本地 marketplace 清单（本仓库即插件源，供本地 / 团队安装）
├── hooks/
│   └── hooks.json           # 生命周期钩子注册（Stop / StopFailure / PostToolUseFailure）
├── commands/
│   └── sound.md             # 斜杠命令 /claudecode-toaster:sound
├── src/
│   ├── index.ts             # 全部核心逻辑：配置 / 钩子 / 播放 / CLI
│   └── sounds/README.md     # 默认音效说明与生成方式
├── scripts/
│   └── generate-sounds.mjs  # 零依赖合成内置音效（simple/success 为真实录音，只复制）
├── assets/sounds/           # 内置音效"源文件"（simple / crisp / tech × 3 状态）
├── dist/                    # 构建产物（index.js + 音效副本；随仓库提交，安装即可用）
├── package.json
├── tsconfig.json
├── README.md
└── CHANGELOG.md             # 更新日志（每次改动随版本记录）
```

---

## 三、安装与本地加载

### 1. 前置条件

- [Claude Code](https://code.claude.com/) 较新版本（支持插件与 `StopFailure` / `PostToolUseFailure` 钩子）
- **Node.js 18+**，且 `node` 在 `PATH` 中（钩子通过 `node` 启动本插件）

```bash
node --version   # 应 >= v18
```

### 2. 获取代码并构建

```powershell
# Windows PowerShell
cd D:\
git clone <your-repo-url> ClaudeCodeToaster   # 或直接使用 D:\_claude-code-toaster
cd ClaudeCodeToaster
npm install          # 仅安装 TypeScript（devDependency），运行时零依赖
npm run build        # tsc 编译 + 生成内置音效（8 个合成 + 1 个真实录音复制）
```

构建后确认存在 `dist/index.js` 与 `dist/sounds/simple/success.wav` 等文件。

### 3. 本地加载插件（开发 / 自用，无需发布）

在**启动 Claude Code 时**用 `--plugin-dir` 加载（官方本地开发方式，可重复 `--plugin-dir` 加载多个）：

```powershell
# 普通模式加载（此时默认不会响，因为默认 bypassOnly=true）
claude --plugin-dir D:\_claude-code-toaster

# 推荐：bypass permissions 自动执行模式 + 本插件（核心使用场景）
claude --dangerously-skip-permissions --plugin-dir D:\_claude-code-toaster
```

macOS / Linux：

```bash
claude --dangerously-skip-permissions --plugin-dir /path/to/ClaudeCodeToaster
```

启动后：

- 用 `/help` 可看到命名空间命令 **`/claudecode-toaster:sound`**
- 用 `/hooks` 可查看本插件注册的 `Stop` / `StopFailure` / `PostToolUseFailure` 三个钩子（来源标记为 Plugin）
- 修改代码后，会话内运行 `/reload-plugins` 即可热更新（改了钩子命令建议重启会话）

### 4.（可选）安装原生 `/sound` 短命令

插件命令自带命名空间前缀（`/claudecode-toaster:sound`）。想要文档示例中的短命令 `/sound`，
加载插件后执行一次：

```
/claudecode-toaster:sound install-shortcut
```

它会在 `~/.claude/commands/sound.md` 生成一个指向本插件的独立命令，此后所有会话里都能直接用
`/sound test`、`/sound toggle` 等。移除用 `/sound uninstall-shortcut`。

### 5. 长期使用 / 团队分发

- 个人长期使用：可把启动命令存成 shell 别名，例如
  PowerShell `function cc-t { claude --dangerously-skip-permissions --plugin-dir D:\_claude-code-toaster @args }`。
- 本仓库自带 `.claude-plugin/marketplace.json`，可直接作为本地 marketplace 安装（比 `--plugin-dir` 更适合长期使用）：

  ```bash
  claude plugin marketplace add D:\_claude-code-toaster
  claude plugin install claudecode-toaster@claudecode-toaster   # 默认 user 级，可加 --scope project/local
  ```

- 团队分发：把本仓库推到 git，其他人 `claude plugin marketplace add <repo-url>` 后同样安装，支持 `--scope user/project/local`。
  注意：Claude Code 安装插件时**不会**执行 `npm install` / `npm run build`，因此 `dist/` 构建产物必须随仓库提交
  （`.gitignore` 已放行 `dist/`）；改动 `src/` 后请运行 `npm run build` 并提交新的 `dist/`。
  本地开发仍可用 `claude --plugin-dir` 加载，改动后 `/reload-plugins` 热更新。

---

## 四、斜杠命令大全

> 以下写作 `/sound ...`；未安装短命令前请替换为 `/claudecode-toaster:sound ...`。
> 写配置的命令默认写入**用户级**，追加 `--project` 写入**项目级**。

| 命令 | 作用 |
|---|---|
| `/sound test` | 依次播放 成功 → 失败 → 中断 三段测试音效 |
| `/sound test success` | 单独测试某个状态音效（`success` / `fail` / `abort`） |
| `/sound toggle` | 一键开启 / 关闭音效总开关 |
| `/sound bypass-only` | 切换「仅 bypass 自动批准模式提醒」开关 |
| `/sound set success <本地文件路径>` | 设置成功音效（fail / abort 同理） |
| `/sound volume success 90` | 设置指定状态音量（0-100，fail / abort 同理） |
| `/sound preset crisp` | 切换内置预设包：`simple`（简洁，默认）/ `crisp`（清脆）/ `tech`（科技风） |
| `/sound reset fail` | 重置单个状态的音效与音量为默认 |
| `/sound reset all` | 全部恢复出厂默认配置 |
| `/sound status` | 查看当前生效配置、解析后的实际音频文件与校验状态 |
| `/sound install-shortcut` | 安装原生 `/sound` 短命令 |
| `/sound uninstall-shortcut` | 移除原生 `/sound` 短命令 |
| `/sound help` | 显示帮助 |

也可以直接在终端调用同一套 CLI（斜杠命令本质就是调它）：

```bash
node dist/index.js sound test
node dist/index.js sound set success "C:\Users\me\Music\ding.wav"
node dist/index.js sound volume abort 60 --project
node dist/index.js sound status
```

---

## 五、配置项

### 配置表（与需求一一对应）

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `enable` | `true` | 音效提醒总开关 |
| `bypassOnly` | `true` | 仅 bypass / 自动批准模式下生效；关闭后所有权限模式都提醒 |
| `successSound` | 内置预设 | 成功音效文件路径（`""` 表示用内置预设） |
| `successVolume` | `80` | 成功音效音量 0-100 |
| `failSound` | 内置预设 | 失败音效文件路径 |
| `failVolume` | `85` | 失败音效音量 0-100 |
| `abortSound` | 内置预设 | 中断音效文件路径 |
| `abortVolume` | `70` | 中断音效音量 0-100 |
| `maxDuration` | `4` | 音效最大播放时长（秒，1-30），防止音频过长 |
| `preset` | `simple` | 内置预设包：`simple` / `crisp` / `tech` |

### 两级持久化存储

| 级别 | 文件位置 | 生效范围 | 写入方式 |
|---|---|---|---|
| 用户级 | `~/.claude/claudecode-toaster/config.json` | 该机器上所有项目 | 写命令默认 |
| 项目级 | `<项目>/.claude/claudecode-toaster.json` | 仅该项目（可提交 git 共享给团队） | 命令追加 `--project` |

合并优先级：**内置默认 < 用户级 < 项目级**。配置文件损坏时自动回退默认值，不会报错。

> 写入语义：命令只把你本次修改的键写入目标级别文件（其余键继续继承，不做默认值补齐），
> 因此 `sound set success <文件> --project` 不会连带把总开关 / 预设 / 音量等无关设置固定到项目级。

---

## 六、自定义音效

- 支持格式：**WAV / MP3 / M4A**，单个文件不超过 50MB
- 设置时会校验文件存在、非空、容器魔数合法（防止填错路径）；校验不通过会拒绝写入
- 支持 `~` 路径与相对路径（相对当前项目目录解析，最终存为绝对路径）
- 运行时自定义文件丢失 / 损坏 → **自动回退内置预设**；内置预设也不可用 → **终端蜂鸣兜底**（BEL，
  Windows 上额外使用 `Console.Beep`），任何一层失败都不会影响 Claude 任务

```
/sound set success C:\Music\success.mp3
/sound set fail    ~/sounds/error.m4a
/sound set abort   ./assets\abort.wav --project
/sound volume success 95
/sound reset success
```

### 内置预设包

全部为 44.1kHz / 单声道 / 16-bit PCM WAV。除 `simple` 的 success 外，音效均由
`scripts/generate-sounds.mjs` 数学合成（正弦/方波 + 包络，零第三方依赖、无版权问题）；
`simple` 的 success 为**真实烤面包机铃声录音**（来源：YouTube 视频
<https://www.youtube.com/watch?v=IoN9UsFh9-I>，作者声明注明出处即可免费使用；
由 `toaster_sound/Toaster Oven Bell Ding.mp3` 裁切而来：去 1.5s 机械前导、保留完整尾音（~3.5s）、峰值归一）。
`crisp` / `tech` 的 success 为同一烤面包机主题的合成版：

| 预设 | success | fail | abort |
|---|---|---|---|
| `simple`（默认） | 真实烤面包机铃声录音（~3.5s） | A3-F3 双音下行 | G3 低沉长音 |
| `crisp` | 烤面包机「叮」清脆版：高音 E7 短铃（~0.37s） | G4-D4 下行 | A4 双短脉冲 |
| `tech` | 烤面包机「叮」电子版：机械「啪」+ G6→C7 双音（~0.5s） | 下行扫频 | C4 方波三响 |

重新生成音效：`npm run sounds`（等价于构建时自动执行的步骤；真实录音只复制、绝不重新合成覆盖，
其源文件 `assets/sounds/simple/success.wav` 必须随仓库提交）。

---

## 七、跨平台播放后端（全部系统原生，零依赖）

| 平台 | WAV | MP3 / M4A | 音量控制 | 时长控制 |
|---|---|---|---|---|
| **macOS** | `afplay` | `afplay` | `afplay -v`（0.0-1.0） | 父进程超时回收 |
| **Windows** | `System.Media.SoundPlayer`（播放前在 Node 侧对 16-bit PCM WAV 做音量缩放与时长裁剪） | 优先 WMP COM（`WMPlayer.OCX`，支持音量）；不可用时回退 `winmm.dll` MCI（MP3 可靠，部分系统不支持 M4A） | WAV：本地重采样保证；MP3/M4A：WMP 支持，MCI 不支持时按原电平 | WAV：裁剪；WMP/MCI：脚本轮询 + 父进程超时 |
| **Linux** | `paplay` → `aplay` → `ffplay` 自动探测 | 仅 `ffplay`（paplay/aplay 不支持压缩格式） | `paplay --volume`（线性 0-65536）/ `ffplay -volume`；`aplay` 无音量参数 | `ffplay -t`；其他由父进程超时回收 |

降级链（每一层失败自动进入下一层，全程静默）：

```
自定义音频文件 → 内置预设 WAV → 终端蜂鸣（BEL / Console.Beep）
        播放器失败（WMP→MCI / paplay→aplay→ffplay）也会继续降级
```

> Windows 说明：在精简版 / N 版 Windows 或 Media Player 组件损坏的机器上，MP3/M4A 可能只能走到
> MCI（MP3 可播但音量不可调）或直接降级为内置 WAV；**WAV 全功能（含独立音量）始终可用**，
> 对音量有强需求时建议自定义音效使用 WAV。Linux 上要播放 MP3/M4A 自定义音效请确保安装 `ffmpeg`（提供 ffplay）。

---

## 八、完整测试流程

### A. 构建自检

```powershell
cd D:\_claude-code-toaster
npm install
npm run build           # tsc 无报错 + 输出 18 个 WAV（assets/ 与 dist/ 各 9 个）
claude plugin validate .   # 应显示 "Validation passed"
node dist\index.js sound test     # 依次听到 success / fail / abort 三个音
node dist\index.js sound status   # 三个文件均显示 OK
```

### B. 不进会话，直接用管道模拟钩子（最快验证，支持排障日志）

PowerShell：

```powershell
$env:TOASTER_DEBUG='1'   # 打开判定日志（输出到 stderr，排障后删除该变量即可）

# 成功：bypass 模式任务正常结束 → 应播放 success
[pscustomobject]@{ hook_event_name='Stop'; permission_mode='bypassPermissions'; session_id='t1'; cwd='D:\_claude-code-toaster' } |
  ConvertTo-Json -Compress | node dist\index.js hook Stop

# 失败：API 错误结束 → 应播放 fail
[pscustomobject]@{ hook_event_name='StopFailure'; session_id='t2'; cwd='D:\_claude-code-toaster'; error='rate_limit' } |
  ConvertTo-Json -Compress | node dist\index.js hook StopFailure

# 中断：工具被用户中断 → 应播放 abort
[pscustomobject]@{ hook_event_name='PostToolUseFailure'; permission_mode='bypassPermissions'; session_id='t3'; cwd='D:\_claude-code-toaster'; is_interrupt=$true } |
  ConvertTo-Json -Compress | node dist\index.js hook PostToolUseFailure

# 对照：default 权限模式（bypassOnly 默认开启）→ 应静默，日志显示 skipped
[pscustomobject]@{ hook_event_name='Stop'; permission_mode='default'; session_id='t4'; cwd='D:\_claude-code-toaster' } |
  ConvertTo-Json -Compress | node dist\index.js hook Stop
```

bash / zsh：

```bash
echo '{"hook_event_name":"Stop","permission_mode":"bypassPermissions","session_id":"t1","cwd":"."}' \
  | TOASTER_DEBUG=1 node dist/index.js hook Stop
```

### C. 真实会话端到端（核心场景）

1. **启动 bypass 模式长任务会话**：

   ```powershell
   claude --dangerously-skip-permissions --plugin-dir D:\_claude-code-toaster
   ```

2. **验证成功音**：下发一个需要多步工具调用的长任务，然后切走去做别的事，例如：

   > 运行 npm test，若有失败请逐个修复直到全部通过，最后总结改动。

   任务彻底跑完、Claude 交还控制权时，响一声 **success**。

3. **验证失败音**：下发一个注定失败且 Claude 无法挽救的任务，例如：

   > 执行 npm run no-such-script，并把结果告诉我。

   以工具失败收尾时响 **fail**；遇到网络 / 限流导致 API 报错（`StopFailure`）同样响 fail。

4. **验证中断音**：先下发一个长时间运行的任务（如大目录检索、`Start-Sleep 300`、完整构建），
   在工具执行过程中按 **Esc（或 Ctrl+C）** 终止本次执行，应响 **abort**。

5. **验证"仅 bypass 模式"静默**：退出后用普通模式启动：

   ```powershell
   claude --plugin-dir D:\_claude-code-toaster
   ```

   同样的任务结束时**不应发声**。执行 `/sound bypass-only` 关闭限制后，普通模式结束也会提醒。

6. **验证自定义与开关**：

   ```
   /sound test fail                      # 试听默认 fail
   /sound set fail D:\Music\my-fail.mp3  # 换成自己的音效
   /sound volume fail 100                # 拉满音量
   /sound preset tech                    # 换科技风预设并 /sound test
   /sound toggle                         # 关闭总开关（任务结束静音），再执行一次恢复
   /sound reset all                      # 恢复出厂
   ```

### D. 调试手段

- 环境变量 `TOASTER_DEBUG=1`：钩子把事件、权限模式、判定结果、播放文件、降级过程写到 stderr
- `claude --debug`（或 `claude --debug-file <path>`）：查看钩子是否匹配、退出码、stdout/stderr
- 会话内 `/hooks`：查看三个钩子是否正确注册、命令路径是否正确
- `/sound status`：确认配置合并结果与每个音效文件的校验状态

---

## 九、卸载

1. 会话内短命令移除：`/sound uninstall-shortcut`（若安装过）
2. 移除加载参数：下次启动不再带 `--plugin-dir`（marketplace 安装则 `claude plugin uninstall claudecode-toaster`）
3. 可选删除配置：`~/.claude/claudecode-toaster/`（用户级）与项目内 `.claude/claudecode-toaster.json`
4. 删除插件目录即可，插件不写注册表、不装系统服务

---

## 十、许可证

MIT，见 [LICENSE](LICENSE)。内置音效中，`simple` 的 success 为外部录音素材（来源与授权说明见「内置预设包」一节，使用/分发时请保留出处署名），其余由脚本合成，可任意使用与修改。
