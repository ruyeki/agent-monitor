// Finding executables safely: PATH only, never the current directory, never a shell. Shared by the Codex and Claude launchers.
import fs from 'node:fs';
import path from 'node:path';
import cp from 'node:child_process';

// The absolute directories on PATH, in order (never a relative one, so never the current directory).
function pathDirs(env) {
  const pathVar = process.platform === 'win32' ? Object.keys(env).find((k) => k.toLowerCase() === 'path') : 'PATH';
  return String(env[pathVar] ?? '').split(path.delimiter).filter((d) => d && path.isAbsolute(d));
}

// An absolute path to an executable, found on PATH only: never the current directory (Windows would pick <cwd>\name.exe first).
export function resolveExe(name, env) {
  if (path.isAbsolute(name)) return name;
  const win = process.platform === 'win32';
  const exts = win ? (/\.(exe|com)$/i.test(name) ? [''] : ['.exe', '.com']) : [''];
  for (const dir of pathDirs(env)) {
    for (const ext of exts) {
      const file = path.join(dir, name + ext);
      try { if (fs.statSync(file).isFile()) return file; } catch { /* not here */ }
    }
  }
  return null;
}

export const SAFE_EXE_ENV = { NoDefaultCurrentDirectoryInExePath: '1' };

// The permission modes a headless resume may be started with.
export const MODES = new Set(['default', 'acceptEdits', 'plan', 'bypassPermissions']);

// Kills a child and its descendants: taskkill /T on Windows, a plain kill elsewhere.
export const defaultKillTree = (pid) => {
  if (process.platform === 'win32') {
    const taskkill = path.join(process.env.SystemRoot || 'C:/Windows', 'System32', 'taskkill.exe');
    cp.execFile(taskkill, ['/pid', String(pid), '/T', '/F'], { windowsHide: true, env: { ...process.env, ...SAFE_EXE_ENV } }, () => {});
  } else { try { process.kill(pid); } catch { /* already gone */ } }
};

// `claude` is an npm shim (claude.cmd) on Windows: find the real claude.exe the shim points to, never the .cmd.
export function resolveClaude(command, env) {
  const direct = resolveExe(command, env);
  if (direct || path.isAbsolute(command)) return direct;
  if (process.platform !== 'win32') return null;
  for (const dir of pathDirs(env)) {
    try {
      if (!fs.statSync(path.join(dir, `${command}.cmd`)).isFile()) continue;
      const exe = path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
      if (fs.statSync(exe).isFile()) return exe;
    } catch { /* not here */ }
  }
  return null;
}
