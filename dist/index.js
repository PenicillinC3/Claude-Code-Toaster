#!/usr/bin/env node
"use strict";
/*
 * ClaudeCodeToaster <https://github.com/claudecode-toaster>
 *
 * bypass permissions 自动执行模式专属的任务完成音效提醒插件。
 *
 * 运行模式：
 *   1. hook 模式（由 hooks/hooks.json 调用）：
 *        node dist/index.js hook <EventName>
 *      从 stdin 读取 Claude Code 注入的 hook JSON，按事件映射播放音效。
 *      全程静默：任何错误都只写 stderr 并以 exit 0 退出，绝不阻塞主任务。
 *
 *   2. 命令模式（由 commands/sound.md 斜杠命令调用，也可直接在终端运行）：
 *        node dist/index.js sound <subcommand> [args]
 *
 * 仅使用 Node.js 原生模块：child_process / fs / os / path。
 */
Object.defineProperty(exports, "__esModule", { value: true });
const child_process_1 = require("child_process");
const fs_1 = require("fs");
const os_1 = require("os");
const path_1 = require("path");
const STATUSES = ['success', 'fail', 'abort', 'notify'];
const PRESETS = ['simple', 'crisp', 'tech'];
/** 同一任务结束事件的防抖窗口（毫秒），窗口内只播放一次 */
const DEBOUNCE_MS = 3000;
/** 出厂默认配置 */
const DEFAULT_CONFIG = {
    enable: true,
    bypassOnly: false,
    successSound: '',
    successVolume: 80,
    failSound: '',
    failVolume: 85,
    abortSound: '',
    abortVolume: 70,
    notifySound: '',
    notifyVolume: 80,
    maxDuration: 4,
    preset: 'simple',
};
/** 插件根目录（编译产物位于 <root>/dist/index.js） */
const PLUGIN_ROOT = (0, path_1.resolve)(__dirname, '..');
/** 用户级配置目录与文件（跨项目生效） */
const USER_CONFIG_DIR = (0, path_1.join)((0, os_1.homedir)(), '.claude', 'claudecode-toaster');
const USER_CONFIG_FILE = (0, path_1.join)(USER_CONFIG_DIR, 'config.json');
/** 防抖跨进程状态文件 */
const STATE_FILE = (0, path_1.join)((0, os_1.tmpdir)(), 'claudecode-toaster-state.json');
const SUPPORTED_EXTENSIONS = ['wav', 'mp3', 'm4a'];
// ============================================================================
// 二、配置加载 / 校验 / 持久化（user / project 两级）
// ============================================================================
/** 读取并解析 JSON 文件，任何异常都返回 null（配置损坏绝不阻塞主任务） */
function readJsonFile(file) {
    try {
        if (!(0, fs_1.existsSync)(file))
            return null;
        return JSON.parse((0, fs_1.readFileSync)(file, 'utf8'));
    }
    catch {
        return null;
    }
}
function clampInt(value, min, max, fallback) {
    const n = typeof value === 'number' ? value : parseInt(String(value ?? ''), 10);
    if (!Number.isFinite(n))
        return fallback;
    return Math.min(max, Math.max(min, Math.round(n)));
}
/** 将任意来源的对象清洗为合法配置（与默认值合并） */
function sanitizeConfig(raw) {
    const cfg = { ...DEFAULT_CONFIG };
    if (!raw)
        return cfg;
    if (typeof raw.enable === 'boolean')
        cfg.enable = raw.enable;
    if (typeof raw.bypassOnly === 'boolean')
        cfg.bypassOnly = raw.bypassOnly;
    if (typeof raw.successSound === 'string')
        cfg.successSound = raw.successSound;
    if (typeof raw.failSound === 'string')
        cfg.failSound = raw.failSound;
    if (typeof raw.abortSound === 'string')
        cfg.abortSound = raw.abortSound;
    if (typeof raw.notifySound === 'string')
        cfg.notifySound = raw.notifySound;
    cfg.successVolume = clampInt(raw.successVolume, 0, 100, DEFAULT_CONFIG.successVolume);
    cfg.failVolume = clampInt(raw.failVolume, 0, 100, DEFAULT_CONFIG.failVolume);
    cfg.abortVolume = clampInt(raw.abortVolume, 0, 100, DEFAULT_CONFIG.abortVolume);
    cfg.notifyVolume = clampInt(raw.notifyVolume, 0, 100, DEFAULT_CONFIG.notifyVolume);
    cfg.maxDuration = clampInt(raw.maxDuration, 1, 30, DEFAULT_CONFIG.maxDuration);
    if (typeof raw.preset === 'string' && PRESETS.includes(raw.preset)) {
        cfg.preset = raw.preset;
    }
    return cfg;
}
/** 项目级配置文件路径：<project>/.claude/claudecode-toaster.json */
function projectConfigFile(cwd) {
    return (0, path_1.join)(cwd, '.claude', 'claudecode-toaster.json');
}
/**
 * 加载最终生效配置：内置默认 < 用户级 < 项目级（后者覆盖前者）。
 */
function loadConfig(cwd) {
    const userCfg = readJsonFile(USER_CONFIG_FILE);
    const projectCfg = readJsonFile(projectConfigFile(cwd));
    return sanitizeConfig({
        ...(userCfg ?? {}),
        ...(projectCfg ?? {}),
    });
}
/**
 * 在指定级别上修改并持久化配置（读取-合并-写入）。
 * 只写入「该文件已显式设置过的键 + 本次 patch」，绝不用默认值补齐整份配置——
 * 否则一次 `sound set x --project` 会把项目级文件写满默认值，
 * 从而在合并时（项目级 > 用户级）覆盖掉用户级的所有真实设置。
 */
function mutateConfig(scope, cwd, patch) {
    const file = scope === 'user' ? USER_CONFIG_FILE : projectConfigFile(cwd);
    (0, fs_1.mkdirSync)((0, path_1.dirname)(file), { recursive: true });
    const existing = readJsonFile(file) ?? {};
    const next = { ...existing, ...patch };
    (0, fs_1.writeFileSync)(file, JSON.stringify(next, null, 2) + '\n', 'utf8');
    return sanitizeConfig(next);
}
// ============================================================================
// 三、音效文件解析与校验
// ============================================================================
/** 展开 ~ 为用户主目录 */
function expandHome(p) {
    if (p === '~')
        return (0, os_1.homedir)();
    if (p.startsWith('~/') || p.startsWith('~\\'))
        return (0, path_1.join)((0, os_1.homedir)(), p.slice(2));
    return p;
}
/** 内置预设音效的实际路径（dist 优先，assets 兜底） */
function defaultSoundPath(preset, status) {
    const candidates = [
        (0, path_1.join)(PLUGIN_ROOT, 'dist', 'sounds', preset, `${status}.wav`),
        (0, path_1.join)(PLUGIN_ROOT, 'assets', 'sounds', preset, `${status}.wav`),
    ];
    return candidates.find((p) => (0, fs_1.existsSync)(p)) ?? candidates[0];
}
/**
 * 解析某个状态最终应播放的文件候选列表（自定义在前，内置兜底在后）。
 * 调用方依次尝试播放，全部失败再降级蜂鸣。
 */
function resolveSoundCandidates(cfg, status, cwd) {
    const custom = expandHome(cfg[`${status}Sound`].trim());
    const list = [];
    if (custom) {
        list.push((0, path_1.isAbsolute)(custom) ? custom : (0, path_1.resolve)(cwd, custom));
    }
    list.push(defaultSoundPath(cfg.preset, status));
    // 去重
    return Array.from(new Set(list));
}
/** 读取文件头部字节用于魔数嗅探 */
function readFileHeader(file, bytes) {
    try {
        const fd = (0, fs_1.openSync)(file, 'r');
        try {
            const buf = Buffer.alloc(bytes);
            const n = (0, fs_1.readSync)(fd, buf, 0, bytes, 0);
            return buf.slice(0, Math.max(n, 0));
        }
        finally {
            (0, fs_1.closeSync)(fd);
        }
    }
    catch {
        return null;
    }
}
/**
 * 校验音频文件：扩展名 + 文件大小 + 容器魔数。
 * 返回识别出的扩展名；不存在 / 过大 / 损坏 / 格式不支持均返回 null。
 */
function sniffAudio(file) {
    try {
        const st = (0, fs_1.statSync)(file);
        if (!st.isFile() || st.size === 0 || st.size > 50 * 1024 * 1024)
            return null;
    }
    catch {
        return null;
    }
    const ext = (0, path_1.extname)(file).slice(1).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.includes(ext))
        return null;
    const head = readFileHeader(file, 4096);
    if (!head)
        return null;
    if (ext === 'wav') {
        // RIFF????WAVE
        if (head.toString('ascii', 0, 4) === 'RIFF' && head.toString('ascii', 8, 12) === 'WAVE') {
            return 'wav';
        }
        return null;
    }
    if (ext === 'mp3') {
        // ID3 标签，或 MPEG 音频帧同步头 0xFFE*
        const hasId3 = head.toString('ascii', 0, 3) === 'ID3';
        const hasFrameSync = head[0] === 0xff && (head[1] & 0xe0) === 0xe0;
        return hasId3 || hasFrameSync ? 'mp3' : null;
    }
    // m4a / mp4 系列：前若干字节内出现 ftyp box
    return head.subarray(0, 64).includes(Buffer.from('ftyp')) ? 'm4a' : null;
}
// ============================================================================
// 四、跨平台音频播放（全部使用系统原生能力，无第三方依赖）
// ============================================================================
/** 启动子进程并在 maxMs 后强制结束，resolve / reject 只触发一次 */
function runProcess(cmd, args, maxMs) {
    return new Promise((resolvePromise, rejectPromise) => {
        let child;
        try {
            child = (0, child_process_1.spawn)(cmd, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'] });
        }
        catch (err) {
            rejectPromise(err instanceof Error ? err : new Error(String(err)));
            return;
        }
        let settled = false;
        const finish = (err) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            if (err)
                rejectPromise(err);
            else
                resolvePromise();
        };
        const timer = setTimeout(() => {
            try {
                child.kill('SIGKILL');
            }
            catch {
                /* ignore */
            }
            // 标记为「已播放但被 maxDuration 截断」，调用方不应视作播放失败而降级重播
            const err = new Error(`playback timeout after ${maxMs}ms`);
            err.timedOut = true;
            finish(err);
        }, maxMs);
        child.on('error', (err) => finish(err));
        child.on('exit', (code) => {
            if (code === 0)
                finish();
            else
                finish(new Error(`${cmd} exited with code ${code}`));
        });
    });
}
/** Linux 下命令是否存在（结果只探测一次） */
const linuxCommandCache = new Map();
function hasLinuxCommand(cmd) {
    const cached = linuxCommandCache.get(cmd);
    if (cached !== undefined)
        return cached;
    try {
        const r = (0, child_process_1.spawnSync)('sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' });
        const ok = r.status === 0;
        linuxCommandCache.set(cmd, ok);
        return ok;
    }
    catch {
        linuxCommandCache.set(cmd, false);
        return false;
    }
}
/** macOS：afplay，-v 控制音量（0.0-1.0），时长由父进程超时保证 */
function playMacOS(file, volume, maxSec) {
    const v = (Math.min(100, Math.max(0, volume)) / 100).toFixed(2);
    return runProcess('afplay', ['-v', v, file], maxSec * 1000 + 800);
}
/** Linux：paplay > aplay > ffplay 自动探测适配 */
function playLinux(file, ext, volume, maxSec) {
    if (ext === 'wav' && hasLinuxCommand('paplay')) {
        // paplay --volume 线性音量范围 0-65536
        const linear = Math.round((volume / 100) * 65536);
        return runProcess('paplay', [`--volume=${linear}`, file], maxSec * 1000 + 800);
    }
    if (ext === 'wav' && hasLinuxCommand('aplay')) {
        // aplay 无音量参数，按原始电平播放
        return runProcess('aplay', ['-q', file], maxSec * 1000 + 800);
    }
    if (hasLinuxCommand('ffplay')) {
        // ffplay 支持 wav/mp3/m4a，-volume 为百分比、-t 限制时长
        return runProcess('ffplay', ['-nodisp', '-autoexit', '-loglevel', 'quiet', '-volume', String(volume), '-t', String(maxSec), file], maxSec * 1000 + 1500);
    }
    return Promise.reject(new Error('no supported audio player found (need paplay/aplay/ffplay)'));
}
/**
 * Windows 专用：按音量与最大时长重新渲染一份 16-bit PCM WAV 临时文件。
 * System.Media.SoundPlayer 不支持音量 / 时长参数，因此在播放前预处理。
 * 仅支持 PCM 16-bit WAV；不支持时返回 null（调用方直接播放原文件）。
 */
function renderAdjustedWav(src, volume, maxSec) {
    try {
        const buf = (0, fs_1.readFileSync)(src);
        if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE')
            return null;
        // 遍历 chunk，定位 fmt 与 data
        let offset = 12;
        let audioFormat = 0;
        let channels = 0;
        let sampleRate = 0;
        let bitsPerSample = 0;
        let dataOffset = -1;
        let dataLength = 0;
        while (offset + 8 <= buf.length) {
            const id = buf.toString('ascii', offset, offset + 4);
            const size = buf.readUInt32LE(offset + 4);
            const body = offset + 8;
            if (id === 'fmt ') {
                audioFormat = buf.readUInt16LE(body);
                channels = buf.readUInt16LE(body + 2);
                sampleRate = buf.readUInt32LE(body + 4);
                bitsPerSample = buf.readUInt16LE(body + 14);
            }
            else if (id === 'data') {
                dataOffset = body;
                dataLength = size;
            }
            offset = body + size + (size % 2); // chunk 按字对齐
        }
        if (audioFormat !== 1 || bitsPerSample !== 16 || channels < 1 || sampleRate < 8000 || dataOffset < 0) {
            return null;
        }
        const bytesPerFrame = channels * 2;
        const maxFrames = Math.floor(sampleRate * maxSec);
        const frames = Math.min(Math.floor(dataLength / bytesPerFrame), maxFrames);
        const outLength = frames * bytesPerFrame;
        const scale = Math.min(1, Math.max(0, volume / 100));
        const out = Buffer.alloc(44 + outLength);
        // RIFF/WAVE 头
        out.write('RIFF', 0, 'ascii');
        out.writeUInt32LE(36 + outLength, 4);
        out.write('WAVE', 8, 'ascii');
        out.write('fmt ', 12, 'ascii');
        out.writeUInt32LE(16, 16);
        out.writeUInt16LE(1, 20); // PCM
        out.writeUInt16LE(channels, 22);
        out.writeUInt32LE(sampleRate, 24);
        out.writeUInt32LE(sampleRate * bytesPerFrame, 28);
        out.writeUInt16LE(bytesPerFrame, 32);
        out.writeUInt16LE(16, 34);
        out.write('data', 36, 'ascii');
        out.writeUInt32LE(outLength, 40);
        for (let i = 0; i < frames * channels; i++) {
            const sample = buf.readInt16LE(dataOffset + i * 2);
            const scaled = Math.round(sample * scale);
            out.writeInt16LE(Math.min(32767, Math.max(-32768, scaled)), 44 + i * 2);
        }
        const tmp = (0, path_1.join)((0, os_1.tmpdir)(), `claudecode-toaster-${Date.now()}-${Math.round(Math.random() * 1e6)}.wav`);
        (0, fs_1.writeFileSync)(tmp, out);
        return tmp;
    }
    catch {
        return null;
    }
}
/** 生成 PowerShell -EncodedCommand 参数（UTF-16LE Base64，彻底规避引号 / 编码问题） */
function psEncodedArgs(script) {
    const b64 = Buffer.from(`\uFEFF${script}`, 'utf16le').toString('base64');
    return ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', b64];
}
/** PowerShell 单引号字符串转义（配合外层 '...' 使用） */
function psQuote(file) {
    return file.replace(/'/g, "''");
}
/** PowerShell 单引号字符串字面量：内部的 $ / ` 一律不展开，单引号翻倍转义 */
function psLiteral(file) {
    return `'${psQuote(file)}'`;
}
/** PowerShell 中通过 winmm.dll MCI 接口播放的脚本（mp3 回退方案，无窗口、系统自带） */
function mciPlaybackScript(file, maxSec) {
    // MCI 不支持音量设置（rc=259），音量由 WMP 路径保证；MCI 仅作为可靠播放回退。
    // 异步 play 后轮询 mode，播完即止或到 maxSec 主动 stop，不依赖进程被杀。
    return [
        `$ErrorActionPreference = 'Stop'`,
        `Add-Type -TypeDefinition @'`,
        `using System;`,
        `using System.Runtime.InteropServices;`,
        `using System.Text;`,
        `public class ToasterMci {`,
        `  [DllImport("winmm.dll", CharSet=CharSet.Auto)]`,
        `  public static extern int mciSendString(string cmd, StringBuilder ret, int retSize, IntPtr hwnd);`,
        `}`,
        `'@`,
        `function Mci([string]$cmd) {`,
        `  $sb = New-Object System.Text.StringBuilder 256`,
        `  $rc = [ToasterMci]::mciSendString($cmd, $sb, 256, [IntPtr]::Zero)`,
        `  if ($rc -ne 0) { throw "MCI failed rc=$rc cmd=$cmd" }`,
        `  return $sb.ToString()`,
        `}`,
        `$alias = 'toaster' + (Get-Random)`,
        `try {`,
        `  Mci ('open "' + ${psLiteral(file)} + '" type mpegvideo alias ' + $alias) | Out-Null`,
        `  Mci "play $alias" | Out-Null`,
        `  $deadline = (Get-Date).AddSeconds(${maxSec})`,
        `  while ((Get-Date) -lt $deadline) {`,
        `    Start-Sleep -Milliseconds 100`,
        `    $mode = Mci "status $alias mode"`,
        `    if ($mode -eq 'stopped') { break }`,
        `  }`,
        `  try { Mci "stop $alias" | Out-Null } catch {}`,
        `} finally {`,
        `  try { Mci "close $alias" | Out-Null } catch {}`,
        `}`,
    ].join('\r\n');
}
/**
 * Windows：
 *  - WAV 走 System.Media.SoundPlayer（播放前在 Node 侧完成音量 / 时长处理）
 *  - MP3 / M4A 优先走 Windows Media Player COM（支持音量与全部常见格式）；
 *    WMP 不可用（如精简版系统 / 组件损坏）时回退到 winmm MCI（mp3）；
 *    仍失败则由调用方降级到内置 WAV / 蜂鸣。
 */
async function playWindows(file, ext, volume, maxSec) {
    if (ext === 'wav') {
        let toPlay = file;
        let tmpFile = renderAdjustedWav(file, volume, maxSec);
        if (tmpFile)
            toPlay = tmpFile;
        try {
            // PlaySync 阻塞至播放结束；临时 WAV 已按时长裁剪，进程级超时仅作兜底
            const script = [
                `$ErrorActionPreference = 'Stop'`,
                `$p = New-Object System.Media.SoundPlayer -ArgumentList '${psQuote(toPlay)}'`,
                `$p.PlaySync()`,
                `$p.Dispose()`,
            ].join('\r\n');
            await runProcess('powershell.exe', psEncodedArgs(script), maxSec * 1000 + 4000);
        }
        finally {
            if (tmpFile) {
                try {
                    (0, fs_1.unlinkSync)(tmpFile);
                }
                catch {
                    /* ignore */
                }
            }
        }
        return;
    }
    const vol = Math.min(100, Math.max(0, Math.round(volume)));
    const max = Math.min(30, Math.max(1, maxSec));
    // 第一选择：Windows Media Player COM（settings.volume 0-100，支持 mp3/m4a）。
    // 1.5 秒内未能进入播放态即快速失败，转 MCI，避免在异常系统上长时间空等。
    const wmpScript = [
        `$ErrorActionPreference = 'Stop'`,
        `try { $wmp = New-Object -ComObject WMPlayer.OCX } catch { exit 2 }`,
        `$wmp.settings.volume = ${vol}`,
        `$wmp.URL = '${psQuote(file)}'`,
        `$wmp.controls.play() | Out-Null`,
        `$readyDeadline = (Get-Date).AddSeconds(1.5)`,
        `$ready = $false`,
        `while ((Get-Date) -lt $readyDeadline) {`,
        `  Start-Sleep -Milliseconds 100`,
        `  if ($wmp.playState -eq 3) { $ready = $true; break }`,
        `}`,
        `if (-not $ready) { try { $wmp.close() } catch {}; exit 2 }`,
        `$deadline = (Get-Date).AddSeconds(${max})`,
        `while ((Get-Date) -lt $deadline) {`,
        `  Start-Sleep -Milliseconds 120`,
        `  if ($wmp.playState -eq 1 -or $wmp.playState -eq 0) { break }`,
        `}`,
        `try { $wmp.close() } catch {}`,
    ].join('\r\n');
    try {
        await runProcess('powershell.exe', psEncodedArgs(wmpScript), maxSec * 1000 + 4000);
        return;
    }
    catch {
        // WMP 不可用 → 继续尝试 MCI
    }
    // 第二选择：winmm MCI（mpegvideo 设备，系统自带；支持 mp3，部分系统不支持 m4a）
    await runProcess('powershell.exe', psEncodedArgs(mciPlaybackScript(file, max)), maxSec * 1000 + 4000);
}
/** 按当前平台播放单个音频文件；失败时抛出，由调用方降级 */
function playFile(file, ext, volume, maxSec) {
    switch ((0, os_1.platform)()) {
        case 'darwin':
            return playMacOS(file, volume, maxSec);
        case 'win32':
            return playWindows(file, ext, volume, maxSec);
        default:
            return playLinux(file, ext, volume, maxSec);
    }
}
/**
 * 终端蜂鸣兜底：BEL 字符；Windows 额外调用 Console.Beep 发出真实声音。
 * 任何播放器 / 音频文件都不可用时使用，保证用户至少得到提示。
 */
function beepFallback(status) {
    try {
        process.stdout.write('\x07');
    }
    catch {
        /* ignore */
    }
    if ((0, os_1.platform)() === 'win32') {
        const freq = status === 'success' ? 1046 : status === 'fail' ? 220 : 156;
        const dur = status === 'success' ? 260 : status === 'fail' ? 420 : 360;
        try {
            (0, child_process_1.spawnSync)('powershell.exe', [...psEncodedArgs(`[console]::beep(${freq}, ${dur})`)], { windowsHide: true, timeout: 2000, stdio: 'ignore' });
        }
        catch {
            /* ignore */
        }
    }
}
/**
 * 播放指定状态的音效：
 * 自定义文件 → 内置预设依次尝试，任何失败都静默降级，最终蜂鸣兜底。
 */
async function playStatus(status, cfg, cwd) {
    const volume = cfg[`${status}Volume`];
    for (const file of resolveSoundCandidates(cfg, status, cwd)) {
        const ext = sniffAudio(file);
        if (!ext) {
            dbg(`candidate invalid or missing: ${file}`);
            continue; // 文件不存在 / 损坏 / 格式不支持 → 尝试下一个候选
        }
        try {
            await playFile(file, ext, volume, cfg.maxDuration);
            dbg(`played ${status}: ${file}`);
            return;
        }
        catch (err) {
            if (err?.timedOut === true) {
                // 播放超时 = 音频已按 maxDuration 截断播放，属于正常结束，不再降级重播
                dbg(`playback capped at maxDuration: ${file}`);
                return;
            }
            dbg(`player failed for ${file}: ${err?.message}`);
            // 播放器失败 → 尝试下一个候选
        }
    }
    dbg(`all candidates failed, using beep fallback (${status})`);
    beepFallback(status);
}
// ============================================================================
// 五、Hook 事件处理
// ============================================================================
/**
 * 判断当前会话是否处于「自动批准执行」模式。
 * 官方权限模式中 bypassPermissions（--dangerously-skip-permissions）
 * 与 dontAsk 均不会弹出权限确认，符合本插件「自动执行模式」定位。
 */
function isAutoApproveMode(mode) {
    if (!mode)
        return true; // 事件未携带该字段时 fail-open（如 StopFailure），避免漏报
    return mode === 'bypassPermissions' || mode === 'dontAsk';
}
/**
 * 分析会话记录：本轮任务是否以「工具调用失败」收尾。
 * 只统计「本轮」（最后一条用户输入之后）的 tool_result；从末尾向前扫描，
 * 遇到本轮起点即停止——否则上一轮的工具错误会被误判为本轮失败，
 * 且一旦会话里出现过任何工具错误，之后每个无工具的轮次都会误报 fail。
 * 子代理（sidechain）的内部记录不参与本轮判定。
 * StopFailure 只覆盖 API 错误；工具执行失败（如测试不通过、命令报错）后
 * Claude 结束响应时，用此启发式判定为 fail。
 */
function transcriptEndedWithError(transcriptPath) {
    if (!transcriptPath)
        return false;
    try {
        const lines = (0, fs_1.readFileSync)(transcriptPath, 'utf8')
            .split(/\r?\n/)
            .filter((l) => l.trim().length > 0);
        // 从末尾向前找本轮最后一个 tool_result；遇到本轮的用户输入即停止
        for (let i = lines.length - 1; i >= 0; i--) {
            let record;
            try {
                record = JSON.parse(lines[i]);
            }
            catch {
                continue;
            }
            if (record.isSidechain === true)
                continue; // 子代理内部消息不参与判定
            const message = record.message;
            const content = message?.content;
            if (Array.isArray(content)) {
                for (let j = content.length - 1; j >= 0; j--) {
                    const block = content[j];
                    if (block && typeof block === 'object' && block.type === 'tool_result') {
                        return block.is_error === true;
                    }
                }
            }
            // 非 tool_result 的用户消息 = 本轮起点：本轮没有失败的工具结果
            if (record.type === 'user' || message?.role === 'user')
                return false;
        }
    }
    catch {
        /* 记录不可读时按成功处理 */
    }
    return false;
}
/**
 * 将官方生命周期事件映射为音效状态。
 *
 * 官方钩子（Claude Code Hooks reference）：
 *   - Stop              主代理完成响应时触发；用户中断时不触发，API 错误由 StopFailure 替代
 *   - StopFailure       turn 因 API 错误（限流 / 鉴权 / 计费 / 服务端等）结束
 *   - PostToolUseFailure 工具调用失败；input.is_interrupt=true 表示由用户中断造成
 *   - Notification      Claude Code 发出通知时触发（hooks.json 用 matcher 过滤并作为 detail 传入）：
 *                       permission_prompt = 权限请求（Claude 被卡住等待批准）。
 *                       仅此类触发 notify 音；idle_prompt（闲置 60s）在正常阅读回复时也会误触、
 *                       体验如同催促，故不播放；auth_success / elicitation_dialog 等同样不发声。
 *
 * @param detail hooks.json 传入的 matcher 值（Notification 事件用于识别通知类型）
 * @returns 音效状态；null 表示该事件不应发声
 */
function mapHookEvent(event, input, detail) {
    switch (event) {
        case 'Stop':
            // stop_hook_active=true 表示因其他 stop hook 阻塞而继续运行，并非真正结束
            if (input.stop_hook_active === true)
                return null;
            return transcriptEndedWithError(input.transcript_path) ? 'fail' : 'success';
        case 'StopFailure':
            return 'fail';
        case 'PostToolUseFailure':
            // 仅在用户主动中断工具执行时播放中断音；普通工具失败留给 Stop 统一判定，
            // 避免每个工具步骤都响（只在任务结束时响一次）。
            return input.is_interrupt === true ? 'abort' : null;
        case 'Notification': {
            // detail 来自 hooks.json 的 matcher（官方机制）；stdin 的 notification_type 字段
            // 未经官方文档确认，仅作兜底。两者都识别不出时保持静默，避免 auth_success 等误响。
            const type = detail || input.notification_type || '';
            return type === 'permission_prompt' ? 'notify' : null;
        }
        default:
            return null;
    }
}
/** 防抖：同一 session + 状态在 DEBOUNCE_MS 窗口内只放行一次 */
function shouldPlay(sessionId, status) {
    try {
        const now = Date.now();
        const state = readJsonFile(STATE_FILE) ?? {};
        const key = `${sessionId}::${status}`;
        const last = typeof state[key] === 'number' ? state[key] : 0;
        // 顺带清理 1 小时前的陈旧记录
        for (const k of Object.keys(state)) {
            if (now - Number(state[k]) > 3600000)
                delete state[k];
        }
        if (last && now - last < DEBOUNCE_MS)
            return false;
        state[key] = now;
        (0, fs_1.mkdirSync)((0, path_1.dirname)(STATE_FILE), { recursive: true });
        (0, fs_1.writeFileSync)(STATE_FILE, JSON.stringify(state), 'utf8');
        return true;
    }
    catch {
        return true; // 状态文件不可写时不影响提醒
    }
}
/** 同步读取 stdin 全部内容（hook 场景 stdin 为管道 JSON） */
function readStdin() {
    try {
        return (0, fs_1.readFileSync)(0, 'utf8');
    }
    catch {
        return '';
    }
}
/** 排障日志：设置环境变量 TOASTER_DEBUG=1 时输出到 stderr（不影响正常使用） */
const DEBUG = process.env.TOASTER_DEBUG === '1';
function dbg(msg) {
    if (DEBUG)
        process.stderr.write(`[ClaudeCodeToaster] ${msg}\n`);
}
/** hook 模式入口：读取事件 JSON → 判定 → 播放，全程不抛出 */
async function runHook(eventArg, detailArg) {
    try {
        const input = JSON.parse(readStdin() || '{}') ?? {};
        const event = eventArg || input.hook_event_name || '';
        const cwd = input.cwd || process.cwd();
        const cfg = loadConfig(cwd);
        dbg(`event=${event} session=${input.session_id ?? '-'} mode=${input.permission_mode ?? '-'} enable=${cfg.enable} bypassOnly=${cfg.bypassOnly}`);
        if (!cfg.enable) {
            dbg('skipped: disabled');
            return;
        }
        const status = mapHookEvent(event, input, detailArg);
        if (!status) {
            dbg('skipped: event maps to no sound');
            return;
        }
        // bypassOnly：非自动批准模式静默；事件未携带 permission_mode 时 fail-open。
        // notify（权限请求）只出现在需要用户介入的普通模式，不受该开关限制。
        if (status !== 'notify' && cfg.bypassOnly && input.permission_mode !== undefined && !isAutoApproveMode(input.permission_mode)) {
            dbg(`skipped: permission_mode=${input.permission_mode} is not an auto-approve mode`);
            return;
        }
        if (!shouldPlay(input.session_id || 'no-session', status)) {
            dbg(`skipped: debounced (${status})`);
            return;
        }
        dbg(`playing: ${status}`);
        await playStatus(status, cfg, cwd);
    }
    catch (err) {
        // 铁律：音效插件任何异常都不得阻塞 / 干扰 Claude 主任务
        try {
            process.stderr.write(`[ClaudeCodeToaster] hook error: ${err?.message}\n`);
        }
        catch {
            /* ignore */
        }
    }
}
// ============================================================================
// 六、斜杠命令 CLI（/claudecode-toaster:sound ...）
// ============================================================================
const HELP_TEXT = `ClaudeCodeToaster - 任务完成 / 权限请求音效提醒

用法：
  node index.js sound test [success|fail|abort|notify]
                                                  测试音效（不指定则依次播放四段）
  node index.js sound toggle                      开启 / 关闭音效总开关
  node index.js sound bypass-only                 切换「仅 bypass 模式提醒」
  node index.js sound set <状态> <音频文件路径> [--project]
                                                  设置自定义音效（wav/mp3/m4a）
  node index.js sound volume <状态> <0-100> [--project]
                                                  设置指定状态音量
  node index.js sound preset <simple|crisp|tech> [--project]
                                                  切换内置预设音效包
  node index.js sound reset <success|fail|abort|notify|all> [--project]
                                                  恢复默认（默认操作用户级配置）
  node index.js sound install-shortcut           在 ~/.claude/commands 安装原生 /sound 短命令
  node index.js sound uninstall-shortcut         移除原生 /sound 短命令
  node index.js sound status                      查看当前生效配置
  node index.js sound help                        显示本帮助

状态取值：success | fail | abort | notify（notify = 权限请求提醒）
配置级别：默认写入用户级（~/.claude/claudecode-toaster/config.json），
          加 --project 写入项目级（<项目>/.claude/claudecode-toaster.json）。`;
function cliPrint(msg) {
    process.stdout.write(`${msg}\n`);
}
function isStatus(s) {
    return STATUSES.includes(s);
}
/** 打印当前配置（sound status） */
function cmdStatus(cwd) {
    const cfg = loadConfig(cwd);
    const lines = [];
    lines.push('ClaudeCodeToaster 当前生效配置');
    lines.push('----------------------------------------');
    lines.push(`总开关 enable            : ${cfg.enable ? '开启' : '关闭'}`);
    lines.push(`仅 bypass 模式 bypassOnly: ${cfg.bypassOnly ? '开启（仅自动批准模式提醒）' : '关闭（所有模式都提醒）'}`);
    lines.push(`预设音效包 preset        : ${cfg.preset}`);
    lines.push(`最大播放时长 maxDuration : ${cfg.maxDuration} 秒`);
    lines.push('----------------------------------------');
    for (const status of STATUSES) {
        const custom = cfg[`${status}Sound`];
        const resolved = resolveSoundCandidates(cfg, status, cwd)[0];
        const valid = sniffAudio(resolved) !== null;
        lines.push(`[${status}] 音量 ${cfg[`${status}Volume`]}\n` +
            `  自定义 : ${custom || '（未设置，使用内置预设）'}\n` +
            `  实际播放: ${resolved} ${valid ? 'OK' : '【缺失/损坏，将蜂鸣兜底】'}`);
    }
    lines.push('----------------------------------------');
    lines.push(`平台 : ${(0, os_1.platform)()}    用户级配置 : ${USER_CONFIG_FILE}`);
    lines.push(`项目级配置 : ${projectConfigFile(cwd)}`);
    cliPrint(lines.join('\n'));
}
/** test：播放测试音效（不受 enable / bypassOnly 限制，便于验证） */
async function cmdTest(args, cwd) {
    const cfg = loadConfig(cwd);
    const rest = args.filter((a) => a !== '--project'); // test 不写配置，容忍误加的 --project
    const targets = rest[0] && isStatus(rest[0]) ? [rest[0]] : STATUSES;
    if (rest[0] && !isStatus(rest[0])) {
        cliPrint(`未知状态「${rest[0]}」，可选：success / fail / abort`);
        process.exitCode = 1;
        return;
    }
    for (const status of targets) {
        cliPrint(`播放测试音效：${status} ...`);
        await playStatus(status, cfg, cwd);
        await new Promise((r) => setTimeout(r, 350));
    }
    cliPrint('测试完成。');
}
/** 解析末尾的 --project 标志 */
function parseScope(args) {
    const scope = args.includes('--project') ? 'project' : 'user';
    return { scope, rest: args.filter((a) => a !== '--project') };
}
function runSoundCommand(argv) {
    const cwd = process.cwd();
    const [sub, ...args] = argv;
    if (!sub || sub === 'help' || sub === '--help' || sub === '-h') {
        cliPrint(HELP_TEXT);
        return;
    }
    if (sub === 'status') {
        cmdStatus(cwd);
        return;
    }
    if (sub === 'install-shortcut') {
        // 生成独立斜杠命令 ~/.claude/commands/sound.md，得到原生 /sound（无插件命名空间前缀）
        const dir = (0, path_1.join)((0, os_1.homedir)(), '.claude', 'commands');
        const target = (0, path_1.join)(dir, 'sound.md');
        const entry = (0, path_1.join)(PLUGIN_ROOT, 'dist', 'index.js');
        const body = [
            '---',
            'description: ClaudeCodeToaster 音效提醒控制：测试、开关、bypassOnly、自定义音效、音量、预设、重置',
            'argument-hint: "[test [success|fail|abort|notify] | toggle | bypass-only | set <success|fail|abort|notify> <路径> | volume <success|fail|abort|notify> <0-100> | preset <simple|crisp|tech> | reset <success|fail|abort|notify|all> | status]"',
            'disable-model-invocation: true',
            'allowed-tools: Bash',
            '---',
            '',
            '# ClaudeCodeToaster /sound 快捷命令',
            '',
            '用户调用了本命令，参数为：`$ARGUMENTS`（可能为空）。',
            '',
            '立即使用 Bash 工具执行下面这一条命令，不要改写路径、不要省略参数、不要先做其他动作；',
            '执行后把标准输出原样展示给用户：',
            '',
            '```bash',
            `node "${entry}" sound $ARGUMENTS`,
            '```',
            '',
        ].join('\n');
        (0, fs_1.mkdirSync)(dir, { recursive: true });
        (0, fs_1.writeFileSync)(target, body, 'utf8');
        cliPrint(`已安装原生短命令：${target}\n此后可直接使用 /sound（如 /sound test）。卸载：sound uninstall-shortcut。`);
        return;
    }
    if (sub === 'uninstall-shortcut') {
        const target = (0, path_1.join)((0, os_1.homedir)(), '.claude', 'commands', 'sound.md');
        try {
            (0, fs_1.unlinkSync)(target);
            cliPrint(`已移除短命令：${target}`);
        }
        catch {
            cliPrint('未发现已安装的 /sound 短命令，无需移除。');
        }
        return;
    }
    if (sub === 'test') {
        void cmdTest(args, cwd);
        return;
    }
    if (sub === 'toggle') {
        const { scope } = parseScope(args);
        const current = loadConfig(cwd);
        const next = mutateConfig(scope, cwd, { enable: !current.enable });
        cliPrint(`音效总开关已${next.enable ? '开启' : '关闭'}（${scope} 级配置）。`);
        return;
    }
    if (sub === 'bypass-only') {
        const { scope } = parseScope(args);
        const current = loadConfig(cwd);
        const next = mutateConfig(scope, cwd, { bypassOnly: !current.bypassOnly });
        cliPrint(`「仅 bypass 模式提醒」已${next.bypassOnly ? '开启' : '关闭'}（${scope} 级配置）。` +
            (next.bypassOnly ? '仅自动批准模式任务结束时提醒。' : '所有权限模式任务结束时都会提醒。'));
        return;
    }
    if (sub === 'preset') {
        const { rest, scope } = parseScope(args);
        const name = rest[0];
        if (!PRESETS.includes(name ?? '')) {
            cliPrint(`用法：sound preset <simple|crisp|tech>`);
            process.exitCode = 1;
            return;
        }
        mutateConfig(scope, cwd, { preset: name });
        cliPrint(`预设音效包已切换为「${name}」（${scope} 级配置）。可运行 sound test 试听。`);
        return;
    }
    if (sub === 'set') {
        const { rest, scope } = parseScope(args);
        const [status, ...pathParts] = rest;
        const soundPath = pathParts.join(' ');
        if (!isStatus(status) || !soundPath) {
            cliPrint('用法：sound set <success|fail|abort> <本地音频文件路径> [--project]');
            process.exitCode = 1;
            return;
        }
        const abs = (0, path_1.isAbsolute)(soundPath) ? soundPath : (0, path_1.resolve)(cwd, expandHome(soundPath));
        if (sniffAudio(abs) === null) {
            cliPrint(`文件无效或格式不支持：${abs}\n仅支持 WAV / MP3 / M4A，且文件须存在、非空、不超过 50MB、未损坏。配置未修改。`);
            process.exitCode = 1;
            return;
        }
        mutateConfig(scope, cwd, { [`${status}Sound`]: abs });
        cliPrint(`已将 ${status} 音效设置为：${abs}（${scope} 级配置）。`);
        return;
    }
    if (sub === 'volume') {
        const { rest, scope } = parseScope(args);
        const [status, value] = rest;
        if (!isStatus(status) || value === undefined) {
            cliPrint('用法：sound volume <success|fail|abort> <0-100> [--project]');
            process.exitCode = 1;
            return;
        }
        const vol = clampInt(value, 0, 100, NaN);
        if (!Number.isFinite(vol)) {
            cliPrint(`音量必须是 0-100 的整数，收到：${value}`);
            process.exitCode = 1;
            return;
        }
        mutateConfig(scope, cwd, { [`${status}Volume`]: vol });
        cliPrint(`已将 ${status} 音量设置为 ${vol}（${scope} 级配置）。`);
        return;
    }
    if (sub === 'reset') {
        const { rest, scope } = parseScope(args);
        const target = rest[0];
        if (target === 'all') {
            // 恢复出厂：该级别写回全部默认值（显式固定默认，覆盖更低级别配置）
            const file = scope === 'user' ? USER_CONFIG_FILE : projectConfigFile(cwd);
            (0, fs_1.mkdirSync)((0, path_1.dirname)(file), { recursive: true });
            (0, fs_1.writeFileSync)(file, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n', 'utf8');
            cliPrint(`已恢复全部出厂默认配置（${scope} 级）：${file}`);
            return;
        }
        if (isStatus(target)) {
            mutateConfig(scope, cwd, {
                [`${target}Sound`]: '',
                [`${target}Volume`]: DEFAULT_CONFIG[`${target}Volume`],
            });
            cliPrint(`已重置 ${target} 音效与音量为默认（${scope} 级配置）。`);
            return;
        }
        cliPrint('用法：sound reset <success|fail|abort|all> [--project]');
        process.exitCode = 1;
        return;
    }
    cliPrint(`未知子命令：${sub}\n\n${HELP_TEXT}`);
    process.exitCode = 1;
}
// ============================================================================
// 七、入口路由
// ============================================================================
function main() {
    const [mode, ...rest] = process.argv.slice(2);
    if (mode === 'hook') {
        void runHook(rest[0], rest[1]);
        return;
    }
    if (mode === 'sound') {
        runSoundCommand(rest);
        return;
    }
    cliPrint(HELP_TEXT);
}
main();
