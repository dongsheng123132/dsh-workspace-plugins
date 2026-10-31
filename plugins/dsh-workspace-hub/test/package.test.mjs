import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'

const root = fileURLToPath(new URL('..', import.meta.url))

test('pack-only consumer resolves bundled CLI and scans an isolated home', async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'wshub-pack-'))
  t.after(() => rm(temp, { recursive: true, force: true }))
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const packed = JSON.parse(execFileSync(npm, ['pack', '--ignore-scripts', '--json', '--pack-destination', temp], { cwd: root, encoding: 'utf8' }))[0]
  const names = packed.files.map((file) => file.path)
  assert.ok(names.includes('hub/wdhub.mjs'))
  assert.ok(names.includes('hub/mcp.mjs'))
  assert.ok(names.includes('hub/lib/platform.mjs'))
  assert.ok(names.includes('hub/adapters/index.mjs'))
  assert.ok(!names.some((name) => /(?:^|\/)(?:node_modules|research|test|\.npmrc|ledger\.json|device\.json)(?:\/|$)/.test(name)))
  assert.ok(!names.some((name) => name.includes('pins-route') || name.startsWith('client/')))
  const consumer = path.join(temp, 'consumer')
  execFileSync(npm, ['install', '--prefix', consumer, '--ignore-scripts', '--legacy-peer-deps', '--offline', '--no-audit', '--no-fund', path.join(temp, packed.filename)], { cwd: temp, encoding: 'utf8' })
  const installed = path.join(consumer, 'node_modules/dsh-plugin-workspace-hub')
  const { defaultHubCliPath } = await import(pathToFileURL(path.join(installed, 'lib/scan.js')).href)
  const cli = defaultHubCliPath()
  assert.equal(cli, await realpath(path.join(installed, 'hub/wdhub.mjs')))
  assert.ok(existsSync(cli))
  const home = path.join(temp, 'user')
  const ledgerHome = path.join(temp, 'ledger')
  await mkdir(home)
  const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData/Roaming'), LOCALAPPDATA: path.join(home, 'AppData/Local'), WSHUB_HOME: ledgerHome, WDHUB_HOME: ledgerHome, CODEX_HOME: path.join(home, '.codex'), CLAUDE_CONFIG_DIR: path.join(home, '.claude'), DSH_HOME: path.join(home, '.dsh') }
  const output = execFileSync(process.execPath, [cli, 'scan', '--save', '--json', '--home', ledgerHome], { cwd: temp, env, encoding: 'utf8', timeout: 60000, maxBuffer: 8 * 1024 * 1024 })
  const scan = JSON.parse(output)
  assert.ok(Array.isArray(scan.adapters))
  assert.ok(scan.adapters.length > 0)
  assert.equal(scan.summary.total, 0)
  assert.deepEqual(JSON.parse(await readFile(path.join(ledgerHome, 'ledger.json'), 'utf8')).workspaces, [])
  // Every relative source import stays inside the tarball, including dynamic MCP.
  const { readdir } = await import('node:fs/promises')
  async function check(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name)
      if (entry.isDirectory()) await check(file)
      else if (file.endsWith('.mjs')) {
        const source = await readFile(file, 'utf8')
        for (const match of source.matchAll(/(?:from\s*|import\s*\()\s*['"](\.[^'"]+)['"]/g)) assert.ok(existsSync(path.resolve(path.dirname(file), match[1])), `${entry.name}: ${match[1]}`)
      }
    }
  }
  await check(path.join(installed, 'hub'))
})
