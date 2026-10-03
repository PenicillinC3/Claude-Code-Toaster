#!/usr/bin/env node
/*
 * ClaudeCodeToaster 默认音效生成脚本（零依赖，Node 原生实现）。
 *
 * 运行：
 *   npm run sounds          # 生成 3 套预设 × 3 个状态 = 9 个 WAV
 *   npm run build           # tsc 编译后会自动调用本脚本
 *
 * 输出位置：
 *   assets/sounds/<preset>/<status>.wav   （仓库内置的“源”音效）
 *   dist/sounds/<preset>/<status>.wav     （运行时实际加载，构建时复制）
 *
 * 除 simple 预设的 success（真实烤面包机铃声录音，见 REAL_RECORDINGS）外，
 * 全部音效为 44.1kHz / 单声道 / 16-bit PCM WAV，由正弦/方波 + ADSR 包络数学合成。
 * 真实录音素材以源文件形式随仓库提交，本脚本只复制到 dist/、绝不重新合成覆盖。
 * 若想替换为自己录制的音效，直接用 /claudecode-toaster:sound set <status> <文件>
 * 即可，无需改本脚本。
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SAMPLE_RATE = 44100;
const BIT_DEPTH = 16;
const CHANNELS = 1;

/**
 * @typedef {Object} Note
 * @property {number} f0        起始频率 Hz
 * @property {number} [f1]      结束频率 Hz（给定则为扫频）
 * @property {number} dur       发声时长 秒
 * @property {number} [gap]     与下一音之间的静默 秒
 * @property {number} [vol]     相对音量 0-1
 * @property {'sine'|'square'} [wave] 波形
 * @property {number} [decay]   指数衰减系数（越大衰减越快）
 * @property {number} [vibrato] 颤音深度（半音分数比例）
 * @property {number} [vibratoRate] 颤音频率 Hz
 */

/** 合成一段音符序列，返回 Float64 采样数组 */
function render(notes) {
  const total = notes.reduce((sum, n) => sum + n.dur + (n.gap ?? 0), 0);
  const samples = new Float64Array(Math.ceil(total * SAMPLE_RATE));
  let cursor = 0;

  for (const note of notes) {
    const start = Math.floor(cursor * SAMPLE_RATE);
    const len = Math.floor(note.dur * SAMPLE_RATE);
    const vol = note.vol ?? 0.6;
    const decay = note.decay ?? 5;
    const attackSamps = Math.floor(0.005 * SAMPLE_RATE);
    const releaseSamps = Math.floor(0.008 * SAMPLE_RATE);

    for (let i = 0; i < len; i++) {
      const t = i / SAMPLE_RATE;
      const p = i / len;
      let freq = note.f1 != null ? note.f0 + (note.f1 - note.f0) * p : note.f0;
      if (note.vibrato) {
        freq *= 1 + note.vibrato * Math.sin(2 * Math.PI * (note.vibratoRate ?? 12) * t);
      }
      const phase = 2 * Math.PI * freq * t;
      let s;
      if (note.wave === 'square') {
        // 方波（基频 + 奇次谐波近似），音量减半避免刺耳
        s = (Math.sin(phase) + 0.33 * Math.sin(3 * phase) + 0.2 * Math.sin(5 * phase)) / 1.53;
      } else {
        // 正弦为主，混入极少量二次谐波让提示音更“实”
        s = Math.sin(phase) + 0.12 * Math.sin(2 * phase);
      }
      s /= 1.12;

      let env;
      if (i < attackSamps) env = i / attackSamps;
      else env = Math.exp(-decay * (p - attackSamps / len));
      if (i > len - releaseSamps) env *= (len - i) / releaseSamps;

      const idx = start + i;
      if (idx < samples.length) samples[idx] += s * env * vol;
    }
    cursor += note.dur + (note.gap ?? 0);
  }

  // 峰值归一化到 0.9，防止削波
  let peak = 0;
  for (const v of samples) peak = Math.max(peak, Math.abs(v));
  if (peak > 0) {
    const gain = 0.9 / peak;
    for (let i = 0; i < samples.length; i++) samples[i] *= gain;
  }
  return samples;
}

/** Float64 采样 → 16-bit PCM WAV Buffer */
function toWavBuffer(samples) {
  const dataLen = samples.length * 2;
  const buf = Buffer.alloc(44 + dataLen);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(CHANNELS, 22);
  buf.writeUInt32LE(SAMPLE_RATE, 24);
  buf.writeUInt32LE(SAMPLE_RATE * CHANNELS * (BIT_DEPTH / 8), 28);
  buf.writeUInt16LE(CHANNELS * (BIT_DEPTH / 8), 32);
  buf.writeUInt16LE(BIT_DEPTH, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataLen, 40);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.min(1, Math.max(-1, samples[i]));
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  return buf;
}

/* ------------------------------------------------------------------------- */
/* 三套预设音效定义                                                           */
/* ------------------------------------------------------------------------- */

const PRESETS = {
  // 简洁：success 为真实烤面包机铃声录音（REAL_RECORDINGS，不在此合成）；
  // fail/abort 保持经典双音下行 / 单低音
  // 注：gap 为负 = 与下一音同时起始（叠加成拍频 / 和声）
  simple: {
    fail: render([
      { f0: 220.0, dur: 0.18, gap: 0.05, vol: 0.65, decay: 4 }, // A3
      { f0: 174.61, dur: 0.34, vol: 0.7, decay: 3.5 }, // F3
    ]),
    abort: render([
      { f0: 196.0, dur: 0.42, vol: 0.68, decay: 3 }, // G3 低沉长音
    ]),
  },

  // 清脆：success 为烤面包机「叮」短促版；其余高频、短促、颗粒感强
  crisp: {
    success: render([
      // 轻弹起：更高的短促方波脉冲
      { f0: 220, dur: 0.03, gap: 0.015, vol: 0.42, wave: 'square', decay: 16 },
      // 单声高音「叮」：双路 E7 微失谐（~8.5Hz 拍频），快速衰减、干脆
      { f0: 2645.5, dur: 0.3, gap: -0.3, vol: 0.45, decay: 7 },
      { f0: 2637.0, dur: 0.32, gap: -0.32, vol: 0.5, decay: 7 },
      { f0: 1318.5, dur: 0.32, vol: 0.2, decay: 8 }, // E6 少量铃体
    ]),
    fail: render([
      { f0: 392.0, dur: 0.11, gap: 0.04, vol: 0.55, decay: 5 }, // G4
      { f0: 293.66, dur: 0.26, vol: 0.6, decay: 4 }, // D4
    ]),
    abort: render([
      { f0: 440.0, dur: 0.08, gap: 0.07, vol: 0.5, decay: 6 }, // A4 短脉冲
      { f0: 440.0, dur: 0.14, vol: 0.5, decay: 5 },
    ]),
  },

  // 科技风：success 为烤面包机「叮」电子版；其余扫频 + 颤音 + 方波脉冲
  tech: {
    success: render([
      // 机械「啪」：方波脉冲 + 极快衰减
      { f0: 330, dur: 0.025, gap: 0.015, vol: 0.45, wave: 'square', decay: 18 },
      // 双音电子叮：G6 → C7 快速上行，第二音带轻微颤音
      { f0: 1567.98, dur: 0.1, gap: 0.02, vol: 0.5, decay: 6 },
      { f0: 2093.0, dur: 0.34, vol: 0.5, decay: 5, vibrato: 0.008, vibratoRate: 10 },
    ]),
    fail: render([
      { f0: 330.0, f1: 98.0, dur: 0.5, vol: 0.55, decay: 2 },
    ]),
    abort: render([
      { f0: 261.63, dur: 0.07, gap: 0.05, vol: 0.5, wave: 'square', decay: 4 }, // C4 方波三响
      { f0: 261.63, dur: 0.07, gap: 0.05, vol: 0.5, wave: 'square', decay: 4 },
      { f0: 261.63, dur: 0.1, vol: 0.5, wave: 'square', decay: 4 },
    ]),
  },
};

/* ------------------------------------------------------------------------- */
/* 真实录音素材（不合成，只复制）                                              */
/* ------------------------------------------------------------------------- */

// simple/success：真实烤面包机铃声录音（外部素材，出处与署名要求见仓库 README）。
// 由 toaster_sound/Toaster Oven Bell Ding.mp3 裁切而来：去 1.5s 机械前导，
// 保留完整尾音（3.5s），峰值归一 -1.5dBFS，44.1kHz / 单声道 / 16-bit PCM。
// 源文件必须随仓库提交；本脚本只把它复制到 dist/，绝不重新合成覆盖。
const REAL_RECORDINGS = ['sounds/simple/success.wav'];

/* ------------------------------------------------------------------------- */
/* 写入 assets/ 与 dist/                                                     */
/* ------------------------------------------------------------------------- */

let synthFiles = 0;
for (const [preset, statuses] of Object.entries(PRESETS)) {
  for (const [status, samples] of Object.entries(statuses)) {
    const buf = toWavBuffer(samples);
    const relPath = join('sounds', preset, `${status}.wav`);
    const assetsPath = join(ROOT, 'assets', relPath);
    const distPath = join(ROOT, 'dist', relPath);
    mkdirSync(dirname(assetsPath), { recursive: true });
    mkdirSync(dirname(distPath), { recursive: true });
    writeFileSync(assetsPath, buf);
    copyFileSync(assetsPath, distPath);
    synthFiles += 2;
  }
}

for (const relPath of REAL_RECORDINGS) {
  const assetsPath = join(ROOT, 'assets', relPath);
  const distPath = join(ROOT, 'dist', relPath);
  if (!existsSync(assetsPath)) {
    throw new Error(
      `缺少真实录音素材：${assetsPath}\n` +
        '该文件必须随仓库提交（本脚本不会合成它）。若为新克隆，请确认 assets/ 完整。',
    );
  }
  const head = readFileSync(assetsPath).subarray(0, 12);
  if (head.toString('ascii', 0, 4) !== 'RIFF' || head.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(`真实录音素材不是合法 WAV（RIFF/WAVE 头缺失）：${assetsPath}`);
  }
  mkdirSync(dirname(distPath), { recursive: true });
  copyFileSync(assetsPath, distPath);
}

console.log(
  `[ClaudeCodeToaster] generated ${synthFiles} synthesized WAV files (assets/ + dist/) ` +
    `+ copied ${REAL_RECORDINGS.length} real recording(s) to dist/.`,
);
