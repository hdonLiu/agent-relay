# Agent Relay

在自己的 Codex 会话里问同事的 Agent，让回答回到原会话。首问在同事授权的项目里新建会话，追问带上同一个 `conversation_id` 即可继续。对方电脑休眠时，云端保留消息，等设备重新上线后投递。

```mermaid
flowchart LR
  A["甲 · 原 Codex 会话 A"] <-->|"stdio MCP 发问 / 本机队列收回答"| CA["甲的本地客户端"]
  CA -->|"HTTPS · ask_peer"| S["云端 MCP、授权和持久信箱"]
  S -->|"乙主动建立的 WSS · 投问题"| CB["乙的本地客户端"]
  CB <-->|"本机队列收问题 / stdio MCP 答复"| B["乙 · 项目会话 B1"]
  CB -->|"HTTPS · reply_to_peer"| S
  S -->|"甲主动建立的 WSS · 投回答"| CA
```

同一仓库构建两个安装包。运营方部署 `server/`，每位用户安装 `client/`。本地客户端包含 MCP 工具入口、后台连接器和宿主适配器。已实现 Codex，其他宿主可从适配器接入。[详细设计、协议和完整时序](docs/design.md)

## 构建安装包

使用 Node.js 24.5 或更高版本、npm 和 Git。测试还需要 OpenSSL。

```sh
git clone https://github.com/hdonLiu/agent-relay.git
cd agent-relay
npm ci
npm test
npm run build
npm pack --workspace @agent-relay/server
npm pack --workspace @agent-relay/client
```

macOS 上可额外运行 `node scripts/smoke-codex.js`，用已安装的 Codex、临时会话和本地模型响应检验原生入队、MCP 回信和同会话续聊。

把生成的包分发到对应机器。在云服务器上执行 `npm install -g ./agent-relay-server-0.1.0.tgz`，在甲乙各自的电脑上执行 `npm install -g ./agent-relay-client-0.1.0.tgz`。

## 启动云端

在同一个服务账号下创建两个用户并启动服务。两条 `issue-user` 命令各显示一次用户管理凭据，分别交给对应用户。再次执行相同用户名会轮换其管理凭据。数据库目录需要持久保存。

```sh
agent-relay-server issue-user alice --db ./data/relay.sqlite
agent-relay-server issue-user bob --db ./data/relay.sqlite
agent-relay-server serve --db ./data/relay.sqlite --host 127.0.0.1 --port 8787
```

让公网域名（下文用 `relay.example.com`）的 HTTPS 反向代理将请求转发到上述端口，保留 `Authorization`，并允许 `/v1/device-stream` 升级为 WebSocket。也可由服务直接终止 TLS，使用 `--host 0.0.0.0 --port 8443 --tls-cert fullchain.pem --tls-key privkey.pem`，客户端地址随之带上 `:8443`。公网客户端要求有效的 TLS 证书。服务健康检查为 `GET /health`。

## 在两台电脑上登记项目

本地支持 macOS 和 Linux。Codex 需已登录，且其本机 app-server 支持代理连接、会话队列及 MCP 调用上下文。已对照的版本是 `0.171.0-alpha.13.2`。先在每台电脑上确认本地 Codex 能正常工作。仅使用 CLI 时，可用 `codex app-server daemon start` 启动本机共享进程，用 `codex app-server daemon version` 查看运行版本。希望将交互式 CLI 会话加入同一个共享进程时，使用 `codex --remote unix://`。

甲执行以下命令，按提示输入 alice 的管理凭据。将目录换成甲自己的工程目录。

```sh
agent-relay setup --server https://relay.example.com \
  --project /path/to/alice-project --target alice/app --allow bob
```

乙执行以下命令，输入 bob 的管理凭据，把自己的项目开放给 alice。

```sh
agent-relay setup --server https://relay.example.com \
  --project /path/to/bob-project --target bob/app --allow alice
```

默认使用 macOS Keychain 或 Linux Secret Service（需要 `secret-tool`）。setup 会向 Codex 注册名为 `peer` 的 stdio MCP 入口，并设置 macOS LaunchAgent 或 Linux 用户级 systemd 服务。若当前 Codex 会话尚未加载工具，重新打开该会话，并按宿主提示授权所需工具。设备在线、用户后台服务和本机 Codex 可用时可以无人收件，审批策略仍由电脑所有者决定。

若计划让两人离开后自动完成问答，可以由各自的所有者在 Codex 配置中只预授权这两个工具，然后重新加载配置。实测版本使用以下 TOML：

```toml
[mcp_servers.peer.tools.ask_peer]
approval_mode = "approve"

[mcp_servers.peer.tools.reply_to_peer]
approval_mode = "approve"
```

- **首问的项目权限**　自动创建的会话使用专用的只读工作区，以登记目录为根，关闭沙箱网络和其他已配置的 MCP。回信通过 `peer` 工具送出。
- **选择已有会话**　乙可为一个单独的别名添加 `--session-id <本机线程 ID>`，显式将获准的首问送进这个旧会话。客户端会核对该线程属于当前账号和登记目录。已有会话沿用所有者的工具和审批权限。
- **调整联系人**　对同一个目录和别名再次运行 setup，使用一个或多个 `--allow` 指定完整名单。`--allow ''` 清空该目标的联系人。
- **手动运行**　`setup --manual` 只登记设备和目标。随后运行 `codex mcp add peer -- agent-relay mcp`，并在本机运行 `agent-relay daemon`。使用自定义状态目录时，这三个入口都要传入相同的 `--state-dir`。无系统凭据库的主机可显式选用 `--credential-store file`，凭据保存在当前用户的私有状态目录。
- **重新登记设备**　设备凭据丢失或被撤销时，使用新状态目录重新登记项目及联系人。旧协作绑定原设备，需要重新发起。

## 在 Codex 里使用

1. 甲在正在工作的会话 A 里说“问一下 `bob/app`，旧版客户端能接受空的 device_id 吗？” Codex 调用 `ask_peer({target, question})`。工具先返回 `conversation_id` 和 `message_id`。
2. 乙的客户端收到投递，在授权项目里新建 B1。乙的 Codex 用 `reply_to_peer({in_reply_to, outcome, text})` 回复。若需要版本号，它可以返回 `needs_info`。
3. 回信进入 A。A 用第一次拿到的 `conversation_id` 补充“最低支持 3.8”。乙在 B1 接着回答，甲在 A 继续原任务。另起事项时再次使用 `target`。

中继服务会存储转发的正文和投递状态，运营方能够读取这些内容。原生会话 ID、工程绝对路径和完整聊天记录留在各自电脑。设备或连接器重启后可以恢复投递。若宿主已经接收输入但无法证实，客户端保留待核对状态，避免在同一会话重复提交。
