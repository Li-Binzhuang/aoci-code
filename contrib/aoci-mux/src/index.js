#!/usr/bin/env node
/**
 * aoci-mux — one MCP server in front of many AOCI repositories.
 *
 * 痛点：AOCI 的 MCP server 是「一个进程绑一个仓库」（仓库在 `--repo`/cwd 里写死，
 * 工具签名没有 repo 参数）。所以接 N 个仓库就要配 N 个 server，宿主里就是
 * N × 9 个同名工具 —— 每轮请求都把这些 schema 全带上。
 *
 * 做法：保留 AOCI 的「一仓库一进程」语义（不改它的任何行为），只在**工具表面**做合并：
 * 对外暴露一份 9 个工具，每个工具多一个 `repo` 枚举参数；调用时按 repo 路由到
 * 对应的子进程。子进程懒启动、空闲回收。
 *
 * 结果：宿主只看到 1 个 server / 9 个工具，而不是 3 个 server / 27 个。
 *
 * 用法：
 *   aoci-mux                       # 作为 stdio MCP server 运行（宿主拉起）
 *   aoci-mux --list                # 打印解析出的仓库与工具（调试，不进入 server）
 *   aoci-mux --selftest            # 逐个仓库连一次、列一次工具，验证连通性
 *   aoci-mux --config <path>       # 指定配置文件（默认 ~/.aoci-mux.json）
 *
 * 配置（~/.aoci-mux.json，全部可选）：
 *   {
 *     "aoci": "/Users/you/.local/bin/aoci",
 *     "repos": ["/abs/repo-a", { "name": "b", "path": "/abs/repo-b" }],
 *     "discover": ["/Users/you/IdeaProjects"],   // 扫一层子目录，含 .aoci/ 或 aoci.txt 的算仓库
 *     "idleMs": 900000                            // 子进程空闲多久回收
 *   }
 */

import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const VERSION = '0.1.0'
const log = (...args) => process.stderr.write('[aoci-mux] ' + args.join(' ') + '\n')

// ── 配置 ────────────────────────────────────────────────────────────────────

function argValue(flag) {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? process.argv[i + 1] : undefined
}

function loadConfig() {
  const explicit = argValue('--config') || process.env.AOCI_MUX_CONFIG
  const path = explicit ? resolve(explicit) : join(homedir(), '.aoci-mux.json')
  let raw = {}
  if (existsSync(path)) {
    try {
      raw = JSON.parse(readFileSync(path, 'utf8'))
    } catch (err) {
      log(`配置文件解析失败（${path}）：${err.message}`)
      process.exit(2)
    }
  } else if (explicit) {
    log(`配置文件不存在：${path}`)
    process.exit(2)
  }
  return {
    path,
    aoci: raw.aoci || join(homedir(), '.local/bin/aoci'),
    repos: Array.isArray(raw.repos) ? raw.repos : [],
    discover: Array.isArray(raw.discover) ? raw.discover : [],
    idleMs: Number.isFinite(raw.idleMs) ? raw.idleMs : 15 * 60 * 1000,
  }
}

/** 一个目录是不是 AOCI 仓库：有 .aoci/ 或 aoci.txt。 */
function isAociRepo(dir) {
  try {
    return statSync(join(dir, '.aoci')).isDirectory() || existsSync(join(dir, 'aoci.txt'))
  } catch {
    return false
  }
}

function resolveRepos(config) {
  const found = new Map() // realpath -> { name, path }
  const add = (p, name) => {
    let real
    try {
      real = realpathSync(resolve(p))
      if (!statSync(real).isDirectory()) return
    } catch {
      log(`跳过不存在的路径：${p}`)
      return
    }
    if (found.has(real)) return
    found.set(real, { name: name || basename(real), path: real })
  }

  for (const entry of config.repos) {
    if (typeof entry === 'string') add(entry)
    else if (entry && typeof entry === 'object' && entry.path) add(entry.path, entry.name)
  }

  for (const root of config.discover) {
    let entries = []
    try {
      entries = readdirSync(root, { withFileTypes: true })
    } catch {
      log(`discover 根目录不可读：${root}`)
      continue
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue
      const dir = join(root, e.name)
      if (isAociRepo(dir)) add(dir)
    }
  }

  // 名字去重（同名仓库加 -2 / -3 后缀）
  const seen = new Map()
  for (const repo of found.values()) {
    const n = seen.get(repo.name) || 0
    seen.set(repo.name, n + 1)
    if (n > 0) repo.name = `${repo.name}-${n + 1}`
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name))
}

// ── 子进程池：一个仓库一个 `aoci --repo X mcp` ──────────────────────────────

class Pool {
  constructor(config, repos) {
    this.config = config
    this.repos = new Map(repos.map((r) => [r.name, r]))
    this.children = new Map() // name -> { client, lastUsed, ready }
    this.timer = setInterval(() => this.evictIdle(), 60_000)
    this.timer.unref?.()
  }

  repo(name) {
    const repo = this.repos.get(name)
    if (!repo) {
      throw new Error(`未知仓库 "${name}"。可用：${[...this.repos.keys()].join(', ')}`)
    }
    return repo
  }

  async clientFor(name) {
    const repo = this.repo(name)
    let slot = this.children.get(name)
    if (slot?.ready) {
      slot.lastUsed = Date.now()
      return slot.client
    }
    if (slot?.pending) return slot.pending

    const transport = new StdioClientTransport({
      command: this.config.aoci,
      args: ['--repo', repo.path, 'mcp'],
      cwd: repo.path,
      stderr: 'inherit', // AOCI 的诊断直接透到宿主 stderr，不吞
    })
    const client = new Client({ name: 'aoci-mux', version: VERSION }, { capabilities: {} })
    const pending = client
      .connect(transport)
      .then(() => {
        this.children.set(name, { client, lastUsed: Date.now(), ready: true })
        return client
      })
      .catch((err) => {
        this.children.delete(name)
        throw new Error(`连接仓库 ${name}（${repo.path}）失败：${err.message}`)
      })
    this.children.set(name, { pending, lastUsed: Date.now(), ready: false })
    return pending
  }

  async evictIdle() {
    const now = Date.now()
    for (const [name, slot] of this.children) {
      if (!slot.ready) continue
      if (now - slot.lastUsed < this.config.idleMs) continue
      this.children.delete(name)
      try {
        await slot.client.close()
        log(`回收空闲子进程：${name}`)
      } catch (err) {
        log(`回收 ${name} 失败：${err.message}`)
      }
    }
  }

  async closeAll() {
    for (const slot of this.children.values()) {
      if (!slot.ready) continue
      try {
        await slot.client.close()
      } catch {}
    }
    this.children.clear()
  }
}

// ── 工具表面 ────────────────────────────────────────────────────────────────

/** 把 AOCI 的工具列表合并成一份：每个工具注入 repo 选择参数。 */
function mergeTools(tools, repoNames) {
  const single = repoNames.length === 1
  const repoParam = {
    type: 'string',
    description: single
      ? `AOCI 仓库（当前只有 ${repoNames[0]}，可省略）`
      : `AOCI 仓库：${repoNames.join(' / ')}。同一套 AOCI 工具服务多个仓库，必须选一个。`,
    ...(single ? { default: repoNames[0] } : { enum: repoNames }),
  }
  return tools.map((tool) => {
    const schema = tool.inputSchema && typeof tool.inputSchema === 'object' ? tool.inputSchema : { type: 'object' }
    const properties = { repo: repoParam, ...(schema.properties || {}) }
    const required = Array.isArray(schema.required) ? schema.required.filter((k) => k !== 'repo') : []
    if (!single) required.unshift('repo')
    return {
      ...tool,
      description: `${tool.description || ''}\n\n（经 aoci-mux 代理；${single ? '单仓库' : '多仓库，用 repo 参数选择'}）`.trim(),
      inputSchema: { ...schema, type: 'object', properties, required },
    }
  })
}

async function buildToolSurface(pool, repoNames) {
  // 用第一个可达仓库的 tools/list 作为权威 schema，避免手抄漂移
  for (const name of repoNames) {
    try {
      const client = await pool.clientFor(name)
      const { tools } = await client.listTools()
      if (Array.isArray(tools) && tools.length > 0) return mergeTools(tools, repoNames)
    } catch (err) {
      log(`用 ${name} 取工具列表失败：${err.message}`)
    }
  }
  throw new Error('所有仓库都取不到工具列表，aoci-mux 无法启动')
}

// ── 主流程 ──────────────────────────────────────────────────────────────────

async function main() {
  const config = loadConfig()
  const repos = resolveRepos(config)
  if (repos.length === 0) {
    log('没有解析到任何仓库：请在配置里写 repos 或 discover，或确认目录含 .aoci/')
    process.exit(2)
  }
  const repoNames = repos.map((r) => r.name)
  log(`仓库：${repos.map((r) => `${r.name}→${r.path}`).join(', ')}`)

  const pool = new Pool(config, repos)

  if (process.argv.includes('--list')) {
    const tools = await buildToolSurface(pool, repoNames)
    process.stdout.write(JSON.stringify({ repos, tools: tools.map((t) => t.name) }, null, 2) + '\n')
    await pool.closeAll()
    return
  }

  if (process.argv.includes('--selftest')) {
    for (const name of repoNames) {
      try {
        const client = await pool.clientFor(name)
        const { tools } = await client.listTools()
        process.stdout.write(`${name.padEnd(14)} ok  ${tools.length} 个工具\n`)
      } catch (err) {
        process.stdout.write(`${name.padEnd(14)} FAIL ${err.message}\n`)
      }
    }
    await pool.closeAll()
    return
  }

  const tools = await buildToolSurface(pool, repoNames)
  const byName = new Map(tools.map((t) => [t.name, t]))

  const server = new Server({ name: 'aoci-mux', version: VERSION }, { capabilities: { tools: {} } })

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }))

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: rawArgs } = req.params
    if (!byName.has(name)) {
      return { content: [{ type: 'text', text: `未知工具：${name}` }], isError: true }
    }
    const args = { ...(rawArgs || {}) }
    const repoName = args.repo || repoNames[0]
    delete args.repo
    try {
      const client = await pool.clientFor(repoName)
      const result = await client.callTool({ name, arguments: args })
      return result
    } catch (err) {
      return {
        content: [{ type: 'text', text: `[${repoName}] ${name} 调用失败：${err.message}` }],
        isError: true,
      }
    }
  })

  await server.connect(new StdioServerTransport())
  log(`已就绪：${repos.length} 个仓库 / ${tools.length} 个工具`)

  const bye = async () => {
    await pool.closeAll()
    process.exit(0)
  }
  process.on('SIGINT', bye)
  process.on('SIGTERM', bye)
}

main().catch((err) => {
  log(`致命错误：${err.message}`)
  process.exit(1)
})
