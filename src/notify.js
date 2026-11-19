// A Windows desktop balloon (NotifyIcon). Text goes in through env vars, never into the script. Never throws; no-op off Windows.
import path from 'node:path';
import cp from 'node:child_process';

const SCRIPT = [
  'Add-Type -AssemblyName System.Windows.Forms, System.Drawing',
  '$n = New-Object System.Windows.Forms.NotifyIcon',
  '$n.Icon = [System.Drawing.SystemIcons]::Information',
  '$n.Visible = $true',
  '$n.ShowBalloonTip(10000, $env:AM_NOTIFY_TITLE, $env:AM_NOTIFY_TEXT, [System.Windows.Forms.ToolTipIcon]::Info)',
  'Start-Sleep -Seconds 12',
  '$n.Dispose()',
].join('; ');

export function desktopNotify(title, text, { spawn = cp.spawn, platform = process.platform, env = process.env } = {}) {
  if (platform !== 'win32') return;
  try {
    const ps = path.join(env.SystemRoot || 'C:/Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const child = spawn(ps, ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', SCRIPT], {
      detached: true, stdio: 'ignore', windowsHide: true, shell: false,
      env: { ...env, AM_NOTIFY_TITLE: String(title).slice(0, 63), AM_NOTIFY_TEXT: String(text).slice(0, 250) },
    });
    child.on?.('error', () => {});
    child.unref?.();
  } catch { /* a notification is best effort */ }
}
