---
name: aoci-mux
description: "Use when working with AOCI (仓库认知层) across more than one local repository, when a tool call needs a `repo` argument, when AOCI tool names collide or the tool list looks duplicated, or when adding/removing a repository from the AOCI integration. Covers the aoci-mux multi-repo MCP proxy, its config file, and troubleshooting. For the AOCI protocol itself (aoci_rules / overview / maintain / update_entry) load the `aoci` skill instead."
---

# aoci-mux — 一个 MCP server，多个 AOCI 仓库

## 痛点与做法

AOCI 的 MCP server 是**一个进程绑一个仓库**的（仓库在 `--repo` 或 cwd 里写死，9 个工具的签名里没有 repo 参数）。

- 直接接法：N 个仓库 = N 个 server = **N × 9 个同名工具**，每轮请求全量带 schema。
- 本机实测：3 个仓库 = 27 个工具 = 13,624 token/请求，**而且三份完全一样**（字节数都一致）。

`aoci-mux` 在中间加一层：**保留 AOCI「一仓库一子进程」的语义**（子进程懒启动、空闲回收），
只在**工具表面**做合并 —— 对外 1 个 server / 9 个工具，每个工具多一个 `repo` 参数。

> 关键：它不是把多个仓库塞进一个 AOCI 进程。`aoci_rules` 的会话合同仍是**按仓库**的，
> 每次调用路由到该仓库自己的子进程，所以 AOCI 的 CAS / 批次 / fail-closed 语义全部不变。

## 怎么用

工具名与原生 AOCI 完全一致（`aoci_rules` / `aoci_overview` / `aoci_search` …），
只是**每次调用都必须带 `repo`**：

```json
{ "name": "aoci_search", "arguments": { "repo": "csv-splitter", "keyword": "formula" } }
```

`repo` 的合法值就是下面配置里解析出来的仓库名（basename）；只有一个仓库时可以省略。

**当前本机仓库**（`~/.aoci-mux.json` 的 `discover` 扫 `~/IdeaProjects` 得到）：

| repo | 路径 |
|---|---|
| `AppHelloRentMarketingService` | `~/IdeaProjects/AppHelloRentMarketingService` |
| `AppHelloRentUserZoneService` | `~/IdeaProjects/AppHelloRentUserZoneService` |
| `csv-splitter` | `~/IdeaProjects/csv-splitter` |

不确定名字时：工具报错会列出全部合法值（`未知仓库 "x"。可用：…`），
或跑 `node ~/Documents/deepseek-harness/default-workspace/aoci-mux/src/index.js --list`。

## 配置 `~/.aoci-mux.json`

```json
{
  "aoci": "/Users/you/.local/bin/aoci",
  "repos": ["/abs/repo-a", { "name": "b", "path": "/abs/repo-b" }],
  "discover": ["/Users/you/IdeaProjects"],
  "idleMs": 900000
}
```

- `repos`：显式列（字符串或 `{name,path}`），优先级最高。
- `discover`：扫这些目录的**下一层**子目录，含 `.aoci/` 或 `aoci.txt` 的算仓库。
- 名字默认取 basename；重名会加 `-2` / `-3` 后缀。
- 改完配置**不用重启 dsh**：子进程是懒启动的，下一次调用就会用新列表；
  但 `tools/list`（仓库名枚举）在 server 启动时生成，**枚举变化需要重连**。

## 排障

```bash
S=~/Documents/deepseek-harness/default-workspace/aoci-mux/src/index.js
node $S --list        # 解析到哪些仓库、暴露哪些工具（不进入 server 模式）
node $S --selftest    # 逐仓库连一次、列一次工具，验证 aoci 可执行与权限
node test/selftest.mjs csv-splitter   # 端到端：真调一次 aoci_rules
```

- 日志一律走 **stderr**（stdout 是 MCP 协议，不能写），宿主里看 `~/.dsh/dsh-web.log` 的 `[aoci-mux]` 行。
- `aoci` 子进程的 stderr 直接 inherit 到宿主，AOCI 自己的报错不会被吞。
- 子进程默认空闲 15 分钟回收；改 `idleMs` 可调。

## 坑

- **别在 mux 外面再配 aoci 的 server**：`mcp-aoci` / `mcp-aoci-csvsplit` / `mcp-aoci-userzone` 三条已经合并成 `mcp-aoci-mux` 一条，
  重复配置会同时出现 `mcp__aoci__aoci_rules` 和 `mcp__aoci-xxx__aoci_rules`，工具表又胖回去。
- **`serverName` 故意叫 `aoci`**：这样工具名保持 `mcp__aoci__aoci_rules`，历史会话/记忆里引用的名字不用改。
- 仓库路径必须存在且是目录，否则启动时跳过并在 stderr 打 `跳过不存在的路径`。
- 一个仓库都没有会在启动时直接退出（exit 2），不会退化成空工具表。
