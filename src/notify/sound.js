'use strict';
// Plays notification sounds with the operating system's own player.
// File paths are passed through environment variables / argv, never spliced
// into a shell command, so a crafted file name cannot run code.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const BUILTIN = ['chime', 'success', 'error', 'alert', 'pop', 'bell'];
const ALLOWED_EXT = new Set(['.wav', '.mp3', '.ogg', '.m4a', '.aac', '.wma', '.aiff', '.flac']);
const MAX_PLAY_MS = 15000;

let extensionPath = '';
let current = null;
let lastPlayed = 0;

function init(extPath) {
  extensionPath = extPath;
}

/** Resolves a sound setting ("chime", "none", "C:\\sounds\\ding.mp3") to a file path or null. */
function resolve(value) {
  if (!value || value === 'none') return null;
  if (BUILTIN.includes(value)) return path.join(extensionPath, 'media', 'sounds', `${value}.wav`);
  if (typeof value !== 'string') return null;
  const ext = path.extname(value).toLowerCase();
  if (!ALLOWED_EXT.has(ext)) return null;
  try {
    const st = fs.statSync(value);
    if (!st.isFile() || st.size > 20 * 1024 * 1024) return null;
  } catch {
    return null;
  }
  return value;
}

const WIN_SCRIPT = [
  'Add-Type -AssemblyName PresentationCore',
  '$p = New-Object System.Windows.Media.MediaPlayer',
  '$p.Volume = [double]$env:CS_VOL',
  '$p.Open([uri]$env:CS_SOUND)',
  '$i = 0; while (-not $p.NaturalDuration.HasTimeSpan -and $i -lt 40) { Start-Sleep -Milliseconds 50; $i++ }',
  '$p.Play()',
  '$ms = 1500; if ($p.NaturalDuration.HasTimeSpan) { $ms = [int]$p.NaturalDuration.TimeSpan.TotalMilliseconds + 150 }',
  'if ($ms -gt 14000) { $ms = 14000 }',
  'Start-Sleep -Milliseconds $ms',
  '$p.Close()',
].join('; ');

/**
 * @param {string} value  builtin name or absolute file path
 * @param {number} volume 0-100
 * @returns {Promise<boolean>} true when playback started
 */
function play(value, volume = 70) {
  const file = resolve(value);
  if (!file) return Promise.resolve(false);

  // avoid a pile-up of sounds when many events fire at once
  const now = Date.now();
  if (now - lastPlayed < 400) return Promise.resolve(false);
  lastPlayed = now;
  stop();

  const vol = Math.max(0, Math.min(100, Number(volume) || 0));
  let cmd, args, env = { ...process.env };

  if (process.platform === 'win32') {
    cmd = 'powershell.exe';
    args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-Command', WIN_SCRIPT];
    env.CS_SOUND = file;
    env.CS_VOL = String(vol / 100);
  } else if (process.platform === 'darwin') {
    cmd = '/usr/bin/afplay';
    args = ['-v', String(vol / 100), file];
  } else {
    // Linux: paplay (PulseAudio/PipeWire) understands most formats; aplay is a fallback for wav
    cmd = 'paplay';
    args = ['--volume', String(Math.round((vol / 100) * 65536)), file];
  }

  return new Promise(resolvePromise => {
    try {
      current = execFile(cmd, args, { env, timeout: MAX_PLAY_MS, windowsHide: true }, err => {
        if (err && process.platform === 'linux' && err.code === 'ENOENT' && file.endsWith('.wav')) {
          execFile('aplay', ['-q', file], { timeout: MAX_PLAY_MS }, () => {});
        }
        current = null;
      });
      resolvePromise(true);
    } catch {
      resolvePromise(false);
    }
  });
}

function stop() {
  if (current) {
    try { current.kill(); } catch { /* already gone */ }
    current = null;
  }
}

module.exports = { init, play, stop, resolve, BUILTIN, ALLOWED_EXT };
