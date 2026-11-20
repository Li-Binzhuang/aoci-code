# aoci-mux — 一个 MCP server，服务多个 AOCI 仓库

> 放在 `contrib/` 下：这是**宿主侧集成**工具，不修改 `aoci` 本身。
> 它只读 AOCI 的公开 MCP 表面，所以与上游的合并互不冲突。

## 问题

`aoci mcp` **一个进程绑一个仓库**：仓库根在启动时由 `--repo` 或 cwd 固定，
九个 MCP 工具的签名里没有 `repo` 参数（见 `docs/agent-integrations.md`
「Several repositories in one Host session」）。宿主按文档「一仓库一条 server 配置」接 N 个仓库，
就得到 **N × 9 个同名工具**：

| 接法 | 工具数 | 每轮请求的 schema |
| --- | ---: | ---: |
| 3 个仓库直接接 | 27 | 13,624 token |
| 经 aoci-mux | **9** | **4,528 token** |

（实测值，`dsh` 侧统计；三个仓库的工具 schema 字节数完全一致，所以 2/3 是纯重复。）

## 方案

保留 AOCI 的「一仓库一子进程」语义，只在**工具表面**做合并：

```
宿主 ──1 个 MCP server──> aoci-mux ──按 repo 路由──> aoci --repo A mcp
                                              └──> aoci --repo B mcp
```

- 对外 9 个工具（名字与原版完全一致），每个多一个 `repo` 枚举参数；
- 子进程懒启动、空闲 15 分钟回收（`idleMs` 可调）；
- `aoci_rules` 的会话合同、CAS、批次、fail-closed 全部**原样保留**——
  每次调用都路由到该仓库自己的进程，代理不改任何语义。

## 安装

```bash
./install.sh            # → ~/.local/share/aoci-mux（可用 AOCI_MUX_HOME 改）
```

宿主配置（DSH 示例）：

```yaml
- insert:
    - id: mcp-aoci-mux
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: aoci          # 故意叫 aoci：工具名保持 mcp__aoci__aoci_rules
        transport: stdio
        command: "/opt/homebrew/bin/node"
        args: ["/Users/you/.local/share/aoci-mux/src/index.js"]
        cwd: "/Users/you/.local/share/aoci-mux"
        failOnStartupError: false
```

`~/.aoci-mux.json`：

```json
{
  "aoci": "/Users/you/.local/bin/aoci",
  "repos": ["/abs/repo-a", { "name": "b", "path": "/abs/repo-b" }],
  "discover": ["/Users/you/IdeaProjects"],
  "idleMs": 900000
}
```

## 自检

```bash
node src/index.js --list        # 解析到哪些仓库、暴露哪些工具
node src/index.js --selftest    # 逐仓库连一次、列一次工具
node test/selftest.mjs csv-splitter   # 端到端真调一次 aoci_rules
```

## 上游同步（这个 fork 的日常）

```bash
./sync-upstream.sh           # fetch + merge upstream/main + 兼容性检查
./sync-upstream.sh --check   # 只看落后多少、不 merge
```

`test/compat.mjs` 会对比当前 `aoci` 的 MCP 工具表面与 `compat/tool-surface.json` 快照：
表面没变 = 代理仍适配；变了 = **必须同步改 `src/index.js` 的注入逻辑**，
确认是有意变更后再 `--update` 快照。这是防止「上游悄悄改了工具签名、代理静默错位」的护栏。

## 约束

- 日志只走 **stderr**（stdout 是 MCP JSON-RPC）。
- 九个工具名是上游声明的公共兼容面，代理**不重命名**任何工具。
- 唯一依赖：`@modelcontextprotocol/sdk`。
