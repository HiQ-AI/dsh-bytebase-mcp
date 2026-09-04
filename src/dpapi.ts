import { spawn } from 'node:child_process'

export interface DataProtector {
  protect(plaintext: string): Promise<string>
  unprotect(ciphertext: string): Promise<string>
}

const ENTROPY = 'dsh-bytebase-mcp:v1'
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024
const POWERSHELL_TIMEOUT_MS = 15_000

const protectScript = `
$ErrorActionPreference = 'Stop'
$inputBase64 = [Console]::In.ReadToEnd()
$plain = [Convert]::FromBase64String($inputBase64)
$entropy = [Text.Encoding]::UTF8.GetBytes('${ENTROPY}')
$cipher = [Security.Cryptography.ProtectedData]::Protect($plain, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Out.Write([Convert]::ToBase64String($cipher))
`

const unprotectScript = `
$ErrorActionPreference = 'Stop'
$inputBase64 = [Console]::In.ReadToEnd()
$cipher = [Convert]::FromBase64String($inputBase64)
$entropy = [Text.Encoding]::UTF8.GetBytes('${ENTROPY}')
$plain = [Security.Cryptography.ProtectedData]::Unprotect($cipher, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Out.Write([Convert]::ToBase64String($plain))
`

function encodePowerShell(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64')
}

async function runDpapi(script: string, input: string): Promise<string> {
  if (process.platform !== 'win32') throw new Error('Bytebase MCP 凭据存储只支持 Windows CurrentUser DPAPI')
  return await new Promise<string>((resolve, reject) => {
    const child = spawn('pwsh.exe', [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      encodePowerShell(script),
    ], {
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let outputBytes = 0
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('Windows DPAPI 操作超时'))
    }, POWERSHELL_TIMEOUT_MS)
    timer.unref()

    child.stdout.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length
      if (outputBytes > MAX_OUTPUT_BYTES) {
        child.kill()
        reject(new Error('Windows DPAPI 返回内容超过安全上限'))
        return
      }
      stdout.push(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      if (Buffer.concat(stderr).length < 4_096) stderr.push(chunk)
    })
    child.on('error', () => {
      clearTimeout(timer)
      reject(new Error('无法启动 PowerShell 7 执行 Windows DPAPI'))
    })
    child.on('close', code => {
      clearTimeout(timer)
      if (code !== 0) {
        const detail = Buffer.concat(stderr).toString('utf8').trim().slice(0, 500)
        reject(new Error(`Windows DPAPI 操作失败${detail === '' ? '' : `：${detail}`}`))
        return
      }
      resolve(Buffer.concat(stdout).toString('utf8').trim())
    })
    child.stdin.end(input)
  })
}

export class WindowsDpapiProtector implements DataProtector {
  async protect(plaintext: string): Promise<string> {
    const encoded = Buffer.from(plaintext, 'utf8').toString('base64')
    return await runDpapi(protectScript, encoded)
  }

  async unprotect(ciphertext: string): Promise<string> {
    const encoded = await runDpapi(unprotectScript, ciphertext)
    return Buffer.from(encoded, 'base64').toString('utf8')
  }
}
