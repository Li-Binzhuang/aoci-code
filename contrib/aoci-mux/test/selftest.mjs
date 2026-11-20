#!/usr/bin/env node
/** 端到端自测：像宿主那样拉起 aoci-mux，列工具，然后真调一次 aoci_rules。 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve(root, 'src/index.js')],
  stderr: 'inherit',
})
const client = new Client({ name: 'aoci-mux-selftest', version: '0.1.0' }, { capabilities: {} })
await client.connect(transport)

const { tools } = await client.listTools()
console.log(`\n工具数：${tools.length}`)
for (const t of tools) {
  const props = Object.keys(t.inputSchema?.properties || {})
  const required = t.inputSchema?.required || []
  console.log(`  ${t.name.padEnd(20)} required=[${required.join(',')}] props=${props.length}`)
}

const rules = tools.find((t) => t.name === 'aoci_rules')
console.log('\nrepo 参数定义：', JSON.stringify(rules?.inputSchema?.properties?.repo))

const repo = process.argv[2] || 'csv-splitter'
console.log(`\n调用 aoci_rules(repo=${repo}) …`)
const res = await client.callTool({ name: 'aoci_rules', arguments: { repo } })
const text = (res.content || []).map((c) => c.text || '').join('\n')
console.log(`isError=${res.isError ? 'true' : 'false'}  返回 ${text.length} 字符`)
console.log(text.slice(0, 400).replace(/\n/g, ' '))

await client.close()
