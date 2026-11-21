/* Windows DPAPI 密钥存储（仅当前用户可解密）
 * ------------------------------------------------------------
 * 密钥不以明文落盘：先用 DPAPI CurrentUser 加密，再写入
 * %LOCALAPPDATA%\ProofTrace\secret.bin。脚本不读取浏览器 localStorage、
 * 聊天记录或源码中的任何密钥。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

function storeDir() {
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(base, 'ProofTrace');
}
function storeFile() { return path.join(storeDir(), 'secret.bin'); }

function isWindows() { return process.platform === 'win32'; }

function psJson(script, input) {
  const out = execFileSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script
  ], { input: input || '', encoding: 'utf8', timeout: 20000, windowsHide: true });
  return String(out || '').trim();
}

const PROTECT_SCRIPT = [
  '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8',
  'Add-Type -AssemblyName System.Security',
  '$raw=[Console]::In.ReadToEnd().Trim()',
  'if(-not $raw){exit 2}',
  '$bytes=[Convert]::FromBase64String($raw)',
  '$enc=[System.Security.Cryptography.ProtectedData]::Protect($bytes,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser)',
  '[Convert]::ToBase64String($enc)'
].join(';');

const UNPROTECT_SCRIPT = [
  '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8',
  'Add-Type -AssemblyName System.Security',
  '$raw=[Console]::In.ReadToEnd().Trim()',
  'if(-not $raw){exit 2}',
  '$bytes=[Convert]::FromBase64String($raw)',
  '$dec=[System.Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser)',
  '[Convert]::ToBase64String($dec)'
].join(';');

function protect(text) {
  if (!isWindows()) {
    const err = new Error('当前系统不是 Windows，未启用 DPAPI 存储');
    err.code = 'dpapi_unavailable';
    throw err;
  }
  const b64 = Buffer.from(String(text), 'utf8').toString('base64');
  return psJson(PROTECT_SCRIPT, b64);
}

function unprotect(cipherB64) {
  if (!isWindows()) {
    const err = new Error('当前系统不是 Windows，未启用 DPAPI 存储');
    err.code = 'dpapi_unavailable';
    throw err;
  }
  const b64 = psJson(UNPROTECT_SCRIPT, String(cipherB64));
  return Buffer.from(b64, 'base64').toString('utf8');
}

function saveSecret(key, model) {
  const cipher = protect(key);
  fs.mkdirSync(storeDir(), { recursive: true });
  const tmp = storeFile() + '.tmp';
  const payload = JSON.stringify({
    v: 1, provider: 'dashscope-compatible', model: model || 'qwen-plus',
    keyCipher: cipher, savedAt: new Date().toISOString()
  });
  fs.writeFileSync(tmp, payload, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, storeFile());
  try {
    if (isWindows()) {
      /* 仅当前用户可读写；DPAPI 之外再收一层文件权限。 */
      execFileSync('icacls', [storeFile(), '/inheritance:r', '/grant:r', process.env.USERNAME + ':F'],
        { windowsHide: true, stdio: 'ignore' });
    }
  } catch (e) { /* 权限收紧失败不影响 DPAPI 加密本身。 */ }
}

function loadSecret() {
  const file = storeFile();
  if (!fs.existsSync(file)) return null;
  let payload;
  try { payload = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { return null; }
  if (!payload || !payload.keyCipher) return null;
  try {
    return { key: unprotect(payload.keyCipher), model: payload.model || '', savedAt: payload.savedAt || '' };
  } catch (e) {
    return null;
  }
}

function clearSecret() {
  const file = storeFile();
  if (fs.existsSync(file)) fs.unlinkSync(file);
  return true;
}

function hasSecret() { return fs.existsSync(storeFile()); }

module.exports = {
  storeDir: storeDir, storeFile: storeFile,
  saveSecret: saveSecret, loadSecret: loadSecret, clearSecret: clearSecret, hasSecret: hasSecret,
  protect: protect, unprotect: unprotect
};
