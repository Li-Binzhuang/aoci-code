#!/usr/bin/env node
/**
 * 兼容性守卫：对比「当前 aoci 的 MCP 工具表面」与 compat/tool-surface.json 快照。
 *
 * 为什么需要：aoci-mux 的全部假设都建在「9 个工具、名字固定、参数里没有 repo」之上。
 * 上游一旦改名/加参数/加工具，代理不会报错，只会静默地把错误的东西暴露给宿主。
 * 所以每次合并上游之后跑一次这个检查：面没变 = 代理仍然适配；变了 = 必须同步改。
 *
 * 用法：
 *   node test/compat.mjs                 # 用 ~/.aoci-mux.json 里第一个仓库
 *   node test/compat.mjs /abs/repo       # 指定仓库
 *   node test/compat.mjs --update        # 重新录快照（确认是有意的表面变更后再用）
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const here = import.meta.dirname
const snapshotPath = join(here, '..', 'compat', 'tool-surface.json')
const update = process.argv.includes('--update')
const aociBin = process.env.AOCI_BIN || join(homedir(), '.local/bin/aoci')

/** 期望的工具数：上游 CONTRIBUTING 把「九个 MCP 工具名」定义为公共兼容面。 */
const EXPECTED_TOOL_COUNT = 9

function firstRepoFromConfig() {
  const configPath = process.env.AOCI_MUX_CONFIG || join(homedir(), '.aoci-mux.json')
  if (!existsSync(configPath)) return null
  try {
    const cfg = JSON.parse(readFileSync(configPath, 'utf8'))
    for (const entry of cfg.repos || []) {
      const p = typeof entry === 'string' ? entry : entry?.path
      if (p && existsSync(p)) return resolve(p)
    }
    for (const root of cfg.discover || []) {
      for (const name of ['csv-splitter', 'AppHelloRentUserZoneService', 'AppHelloRentMarketingService']) {
        const p = join(root, name)
        if (existsSync(join(p, '.aoci'))) return p
      }
    }
  } catch {}
  return null
}

/** 归一化：只保留「代理依赖」的那部分表面（名字 / 必填 / 参数名与类型）。 */
function normalize(tools) {
  return tools
    .map((tool) => {
      const schema = tool.inputSchema || {}
      const properties = Object.fromEntries(
        Object.entries(schema.properties || {})
          .map(([key, value]) => [key, value?.type || 'any'])
          .sort(([a], [b]) => a.localeCompare(b)),
      )
      return {
        name: tool.name,
        required: [...(schema.required || [])].sort(),
        properties,
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}

async function liveSurface(repo) {
  const transport = new StdioClientTransport({
    command: aociBin,
    args: ['--repo', repo, 'mcp'],
    cwd: repo,
    stderr: 'ignore',
  })
  const client = new Client({ name: 'aoci-mux-compat', version: '0.1.0' }, { capabilities: {} })
  await client.connect(transport)
  try {
    const { tools } = await client.listTools()
    return normalize(tools)
  } finally {
    await client.close()
  }
}

function diff(expected, actual) {
  const lines = []
  const exp = new Map(expected.map((t) => [t.name, t]))
  const act = new Map(actual.map((t) => [t.name, t]))
  for (const [name, tool] of exp) {
    if (!act.has(name)) lines.push(`- 工具消失：${name}`)
    else if (JSON.stringify(tool) !== JSON.stringify(act.get(name))) {
      const a = act.get(name)
      if (JSON.stringify(tool.required) !== JSON.stringify(a.required)) {
        lines.push(`~ ${name}.required：${JSON.stringify(tool.required)} → ${JSON.stringify(a.required)}`)
      }
      const keys = new Set([...Object.keys(tool.properties), ...Object.keys(a.properties)])
      for (const key of keys) {
        if (tool.properties[key] !== a.properties[key]) {
          lines.push(`~ ${name}.${key}：${tool.properties[key] ?? '(缺失)'} → ${a.properties[key] ?? '(删除)'}`)
        }
      }
    }
  }
  for (const name of act.keys()) if (!exp.has(name)) lines.push(`+ 新增工具：${name}`)
  return lines
}

const repoArg = process.argv.slice(2).find((a) => !a.startsWith('--'))
const repo = repoArg ? resolve(repoArg) : firstRepoFromConfig()
if (!repo) {
  console.error('✗ 找不到仓库：传一个路径，或在 ~/.aoci-mux.json 里配 repos/discover')
  process.exit(2)
}
if (!existsSync(join(repo, '.aoci')) && !existsSync(join(repo, 'aoci.txt'))) {
  console.error(`✗ ${repo} 不是 AOCI 仓库（没有 .aoci/ 或 aoci.txt）`)
  process.exit(2)
}

const actual = await liveSurface(repo)

// 代理的硬假设：工具数固定、参数里没有 repo（否则注入会撞车）
const problems = []
if (actual.length !== EXPECTED_TOOL_COUNT) {
  problems.push(`工具数 ${actual.length} ≠ 期望的 ${EXPECTED_TOOL_COUNT}`)
}
for (const tool of actual) {
  if (Object.hasOwn(tool.properties, 'repo')) problems.push(`${tool.name} 自己声明了 repo 参数，代理注入会冲突`)
}

if (update) {
  writeFileSync(snapshotPath, JSON.stringify(actual, null, 2) + '\n')
  console.log(`✓ 已更新快照：${snapshotPath}（${actual.length} 个工具）`)
  process.exit(problems.length ? 1 : 0)
}

if (!existsSync(snapshotPath)) {
  console.error(`✗ 没有快照：先跑一次 --update 记录当前表面`)
  process.exit(2)
}

const expected = JSON.parse(readFileSync(snapshotPath, 'utf8'))
const lines = [...problems, ...diff(expected, actual)]

if (lines.length === 0) {
  console.log(`✓ 工具表面未变（${actual.length} 个工具，仓库 ${repo}）—— aoci-mux 仍然适配`)
  process.exit(0)
}

console.error(`✗ 工具表面变了（仓库 ${repo}）：`)
for (const line of lines) console.error('  ' + line)
console.error('\n→ 同步调整 contrib/aoci-mux/src/index.js 的注入逻辑，确认无误后再 --update 快照。')
process.exit(1)
