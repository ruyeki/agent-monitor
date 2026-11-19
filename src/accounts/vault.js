// Saved Claude logins in Windows Credential Manager (generic credentials, DPAPI, persisted per machine user).
// One PowerShell process per batch: ops JSON on stdin, results JSON on stdout, so secrets never reach argv, env or logs.
// Errors name the operation and target only, never a value, PowerShell's stderr or its stdout.
import path from 'node:path';
import cp from 'node:child_process';
import { guardPrefix } from './paths.js';

const KEY = /^[a-z0-9][a-z0-9/_-]{0,99}$/;
const MAX_INLINE = 2000; // bytes; a blob holds at most 2560
const TIMEOUT_MS = 60_000;

// Header blob: '=' + value inline, or '#<n>' for a value split over <target>#0..n-1.
const CS = String.raw`
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class AmVault {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct CRED {
    public uint Flags; public uint Type; public string TargetName; public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public uint BlobSize; public IntPtr Blob; public uint Persist;
    public uint AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;
  }
  [DllImport("advapi32.dll", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredWrite(ref CRED c, uint flags);
  [DllImport("advapi32.dll", EntryPoint = "CredDeleteW", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredDelete(string target, uint type, uint flags);
  [DllImport("advapi32.dll", EntryPoint = "CredEnumerateW", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredEnumerate(string filter, uint flags, out uint count, out IntPtr creds);
  [DllImport("advapi32.dll", EntryPoint = "CredFree")]
  static extern void CredFree(IntPtr p);
  const int NOT_FOUND = 1168;

  static string Q(string s) {
    var b = new StringBuilder("\"");
    foreach (char c in s) {
      if (c == '"' || c == '\\') b.Append('\\').Append(c);
      else if (c < 0x20 || c > 0x7e) b.AppendFormat("\\u{0:x4}", (int)c);
      else b.Append(c);
    }
    return b.Append('"').ToString();
  }
  static string Fail(string fn, int code) { return "{\"error\":" + Q(fn) + ",\"code\":" + code + "}"; }

  // Generic credentials whose target starts with prefix: [target, base64 blob or null].
  static List<string[]> List(string prefix, bool blobs, out int err) {
    var res = new List<string[]>();
    uint n; IntPtr arr; err = 0;
    if (!CredEnumerate(prefix + "*", 0, out n, out arr)) { int e = Marshal.GetLastWin32Error(); if (e != NOT_FOUND) err = e; return res; }
    try {
      for (int i = 0; i < n; i++) {
        var c = (CRED)Marshal.PtrToStructure(Marshal.ReadIntPtr(arr, i * IntPtr.Size), typeof(CRED));
        if (c.Type != 1 || c.TargetName == null || !c.TargetName.StartsWith(prefix, StringComparison.Ordinal)) continue;
        string b64 = null;
        if (blobs) {
          var data = new byte[c.BlobSize];
          if (c.BlobSize > 0) Marshal.Copy(c.Blob, data, 0, (int)c.BlobSize);
          b64 = Convert.ToBase64String(data);
          Array.Clear(data, 0, data.Length);
        }
        res.Add(new string[] { c.TargetName, b64 });
      }
    } finally { CredFree(arr); }
    return res;
  }

  static string Write(string target, string b64) {
    byte[] data = Convert.FromBase64String(b64);
    IntPtr p = Marshal.AllocHGlobal(Math.Max(1, data.Length));
    try {
      Marshal.Copy(data, 0, p, data.Length);
      var c = new CRED();
      c.Type = 1; c.TargetName = target; c.BlobSize = (uint)data.Length; c.Blob = p; c.Persist = 2; c.UserName = "agent-monitor";
      if (!CredWrite(ref c, 0)) return Fail("CredWriteW", Marshal.GetLastWin32Error());
      return "{\"ok\":true}";
    } finally {
      Marshal.Copy(new byte[data.Length], 0, p, data.Length);
      Marshal.FreeHGlobal(p);
      Array.Clear(data, 0, data.Length);
    }
  }

  static string Delete(string target) {
    if (CredDelete(target, 1, 0)) return "{\"ok\":true}";
    int e = Marshal.GetLastWin32Error();
    return e == NOT_FOUND ? "{\"ok\":true}" : Fail("CredDeleteW", e);
  }

  public static string Do(string op, string a, string b, string[] keep) {
    try {
      int err;
      if (op == "write") return Write(a, b);
      if (op == "delete") return Delete(a);
      if (op == "read" || op == "names") {
        var items = List(a, op == "read", out err);
        if (err != 0) return Fail("CredEnumerateW", err);
        var sb = new StringBuilder(op == "read" ? "{\"items\":[" : "{\"names\":[");
        for (int i = 0; i < items.Count; i++) {
          if (i > 0) sb.Append(',');
          if (op == "read") sb.Append("{\"target\":" + Q(items[i][0]) + ",\"blob\":" + Q(items[i][1]) + "}");
          else sb.Append(Q(items[i][0]));
        }
        return sb.Append("]}").ToString();
      }
      if (op == "prune") {
        var keepSet = new HashSet<string>(keep, StringComparer.Ordinal);
        int deleted = 0;
        foreach (var it in List(a, false, out err)) {
          if (keepSet.Contains(it[0])) continue;
          string r = Delete(it[0]);
          if (r.StartsWith("{\"error\"")) return r;
          deleted++;
        }
        if (err != 0) return Fail("CredEnumerateW", err);
        return "{\"deleted\":" + deleted + "}";
      }
      return Fail("op", 0);
    } catch (Exception x) { return "{\"error\":" + Q(x.GetType().Name) + "}"; }
  }
}
`;

const PS = `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
  Add-Type -TypeDefinition @'
${CS}
'@
  $ops = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $out = New-Object System.Text.StringBuilder
  [void]$out.Append('{"results":[')
  $i = 0
  foreach ($o in $ops) {
    if ($i -gt 0) { [void]$out.Append(',') }
    $keep = [string[]]@($o.keep | Where-Object { $_ })
    [void]$out.Append([AmVault]::Do([string]$o.op, [string]$o.a, [string]$o.b, $keep))
    $i++
  }
  [void]$out.Append(']}')
  [Console]::Out.Write($out.ToString())
} catch {
  [Console]::Out.Write('{"fatal":"' + $_.Exception.GetType().Name + '"}')
  exit 1
}
`;
const ENCODED = Buffer.from(PS, 'utf16le').toString('base64');

// Runs one batch in PowerShell -> {code, stdout}.
function runPowerShell(input) {
  if (process.platform !== 'win32') return Promise.reject(new Error('vault: Windows Credential Manager is only available on Windows'));
  const exe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return new Promise((resolve, reject) => {
    const child = cp.spawn(exe, ['-NoProfile', '-NonInteractive', '-EncodedCommand', ENCODED], {
      shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, NoDefaultCurrentDirectoryInExePath: '1' },
    });
    let stdout = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('vault: PowerShell timed out')); }, TIMEOUT_MS);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c) => { stdout += c; });
    child.on('error', (e) => { clearTimeout(timer); reject(new Error(`vault: PowerShell could not start (${e.code ?? 'error'})`)); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout }); });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

const b64 = (buf) => buf.toString('base64');
// Only names the script itself produces get into an error message.
const errName = (s) => (/^(Cred(Write|Delete|Enumerate)W|op|[A-Za-z.]{1,80}Exception)$/.test(String(s)) ? String(s) : 'unknown error');

// createVault({prefix}) -> {prefix, get, getMany, set, setMany, delete, list}. Keys look like `account/<name>` or `backup`.
// run(inputJson) -> Promise<{code, stdout}> replaces PowerShell in tests.
export function createVault({ prefix, run = runPowerShell } = {}) {
  guardPrefix(prefix);
  const target = (key) => {
    if (typeof key !== 'string' || !KEY.test(key)) throw new Error('vault: invalid key');
    return prefix + key;
  };

  async function batch(ops) {
    const { code, stdout } = await run(JSON.stringify(ops));
    let out;
    try { out = JSON.parse(stdout); } catch { throw new Error(`vault: PowerShell failed (exit ${code})`); }
    if (out?.fatal) throw new Error(`vault: PowerShell failed (${errName(out.fatal)})`);
    if (!Array.isArray(out?.results) || out.results.length !== ops.length) throw new Error(`vault: PowerShell failed (exit ${code})`);
    out.results.forEach((r, i) => {
      if (r?.error) throw new Error(`vault: ${errName(r.error)} failed${Number.isInteger(r.code) && r.code ? ` (error ${r.code})` : ''} on ${ops[i].a}`);
    });
    return out.results;
  }

  const writeOps = (key, value) => {
    const t = target(key);
    const buf = Buffer.from(String(value), 'utf8');
    if (buf.length <= MAX_INLINE) return [{ op: 'write', a: t, b: b64(Buffer.from(`=${value}`, 'utf8')) }, { op: 'prune', a: `${t}#`, keep: [] }];
    const ops = [];
    for (let i = 0; i * MAX_INLINE < buf.length; i++) ops.push({ op: 'write', a: `${t}#${i}`, b: b64(buf.subarray(i * MAX_INLINE, (i + 1) * MAX_INLINE)) });
    return [...ops, { op: 'write', a: t, b: b64(Buffer.from(`#${ops.length}`)) }, { op: 'prune', a: `${t}#`, keep: ops.map((o) => o.a) }];
  };

  const decode = (key, items) => {
    const t = target(key);
    const blobs = new Map(items.filter((it) => it.target === t || it.target.startsWith(`${t}#`)).map((it) => [it.target, Buffer.from(it.blob, 'base64')]));
    const head = blobs.get(t);
    if (!head) return null;
    const mark = String.fromCharCode(head[0]);
    if (mark === '=') return head.subarray(1).toString('utf8');
    const n = mark === '#' ? Number(head.subarray(1).toString('utf8')) : NaN;
    if (!Number.isInteger(n) || n < 1) throw new Error(`vault: ${t} has an unknown format`);
    const parts = [];
    for (let i = 0; i < n; i++) {
      const p = blobs.get(`${t}#${i}`);
      if (!p) throw new Error(`vault: ${t} is incomplete`);
      parts.push(p);
    }
    return Buffer.concat(parts).toString('utf8');
  };

  async function getMany(keys) {
    const res = await batch(keys.map((k) => ({ op: 'read', a: target(k) })));
    return Object.fromEntries(keys.map((k, i) => [k, decode(k, res[i].items ?? [])]));
  }

  async function setMany(entries) {
    const ops = Object.entries(entries).flatMap(([k, v]) => writeOps(k, v));
    if (ops.length) await batch(ops);
  }

  return {
    prefix,
    getMany,
    get: async (key) => (await getMany([key]))[key],
    setMany,
    set: (key, value) => setMany({ [key]: value }),
    async delete(key) { const t = target(key); await batch([{ op: 'delete', a: t }, { op: 'prune', a: `${t}#`, keep: [] }]); },
    async list() {
      const [r] = await batch([{ op: 'names', a: prefix }]);
      return (r.names ?? []).map((n) => n.slice(prefix.length)).filter((k) => KEY.test(k)).sort();
    },
  };
}

// In-memory stand-in with the same API, for tests of code that takes a vault.
export function memoryVault(initial = {}) {
  const m = new Map(Object.entries(initial));
  return {
    prefix: 'memory/',
    entries: m,
    getMany: async (keys) => Object.fromEntries(keys.map((k) => [k, m.has(k) ? m.get(k) : null])),
    get: async (k) => (m.has(k) ? m.get(k) : null),
    setMany: async (entries) => { for (const [k, v] of Object.entries(entries)) m.set(k, String(v)); },
    set: async (k, v) => { m.set(k, String(v)); },
    delete: async (k) => { m.delete(k); },
    list: async () => [...m.keys()].sort(),
  };
}
