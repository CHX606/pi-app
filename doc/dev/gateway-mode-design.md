# Gateway mode: headless pi host + desktop as remote client

Status: **design, not implemented**. Answers [justhil/pi-app#13](https://github.com/justhil/pi-app/issues/13)
(支持 Server/Client 网关模式 — Headless Service + Remote Sync).

## 1. Summary

- The phone remote already is most of a gateway. `RemoteGateway` (`src/main/remote/gateway.ts`) talks only
  to the `RemoteHostPort` interface (`src/main/remote/host-port.ts`), which was written so it "could later
  run headless". The transport, the Noise-IK handshake, the device registry and the RPC/event protocol can be
  reused as they are.
- The pi worker already runs under plain Node. WSL mode starts `node worker.mjs` with
  `PI_WORKER_STDIO=1` framing (`src/worker/worker-transport.ts`, `src/main/wsl/worker-host.ts`). A
  headless host needs a third transport, "local node child", not a new worker.
- **Recommended topology: execution follows the workspace.** Each workspace belongs to one host, and its
  tools run on that host, where the files are. Every pi Desktop is already a host. The NAS becomes one more
  host plus the **authority for shared config** (skills, pi settings, models, keys). A desktop can connect to
  several hosts at once. Its own machine is the "local" host. This covers both the issue (one place for keys
  and skills) and the commenter (each PC still works on its own files). That topology does not need a
  cross-machine file bridge inside the agent loop.
- **Phase 1 (smallest useful slice):** a `pi-host` headless process for Linux. It is the existing gateway plus
  a Node `RemoteHostPort` and a Node worker transport, paired from the CLI. The Android app works with it
  unchanged. Desktop-as-client is phase 2.

## 2. The ask

From the issue:

1. A lightweight Linux server that runs headless on a NAS, binds a port (for example 1111) and exposes
   WS/HTTP. It holds the cloud API keys and the skill repository.
2. A "remote connection mode" in the desktop app, which then works only as a UI shell. All LLM requests go
   out through the server.
3. Skills and system settings converge when several clients log in.

The commenter (wanchayuxia-prog) adds that each computer with the software installed should read **its own
local files**, not the NAS's. They give opencode `--serve` as the counter-example, because its client only
sees the server's files.

These two wishes pull against each other. "The UI is only a shell and the server runs everything" means
server files. "Read my local files" means local execution. The design resolves this in §6.

## 3. What exists today

| Piece | Where | Reuse in gateway mode |
|---|---|---|
| Wire frames (`req`/`res`/`evt`/`ping`, `v: 1`) | `packages/shared/remote/frames.ts` | As is |
| Handshake (Noise IK shape, X25519 + HKDF + ChaCha20-Poly1305), `SecureChannel` | `packages/shared/remote/crypto.ts` | As is. Node-only, already pure JS for the AEAD |
| Pair link `pidesk://pair#…`, 5-min one-shot token, private-endpoint guard | `packages/shared/remote/pairing.ts` | As is. The endpoint policy needs an opt-in (§7) |
| RPC table (~35 methods, zod, viewer/operator role) | `packages/shared/remote/methods.ts` | As is for phones. Desktop clients need more (§5) |
| Timeline projection (AppEvent → Turn/TurnPatch, ring buffer, resume by cursor) | `src/main/remote/session-hub.ts`, `projector.ts` | As is |
| Extension UI routing (first answer wins, dismiss elsewhere) | `src/main/remote/ui-router.ts` | As is. Already multi-client |
| Device registry, host key, pairing tokens | `src/main/remote/auth-store.ts` | As is, given a `storage` and `secrets` |
| Gateway server, rate limit, LAN/Tailscale endpoint discovery | `src/main/remote/gateway.ts`, `tailnet.ts` | Needs an `--advertise` override for Docker/NAS |
| Desktop implementation of the port | `src/main/remote-host-electron.ts` | **Replaced** by a Node port. Most logic moves to shared helpers |
| In-memory host + Node client | `src/main/remote/testing/fake-host.ts`, `node-client.ts`, `scripts/remote/dev-host.ts` | Test harness for everything below |
| Android client (Kotlin; crypto, protocol, TurnStore) | `apps/mobile/shared/src/{commonMain,jvmMain}` | Works against a headless host unchanged |
| Worker (pi SDK session) | `src/worker/*` | As is. Stdio mode already runs under plain Node |
| Worker pool | `src/main/worker-manager*.ts` | Needs Electron removed: `utilityProcess`, `BrowserWindow` |
| IPC handlers (~199 channels) and in-process `invokeHandler` | `src/main/ipc/registry.ts`, `handlers/*` | Registry needs to work without `ipcMain`; some handlers import `electron` |

Electron coupling on the path the gateway uses today:

- `ipc:session.list` / `ipc:session.getMessages` (`handlers/session.ts`) do not import `electron`.
- `ipc:model.*`, `ipc:thinkingLevel.set` and `ipc:context.preview` (`handlers/model-runtime.ts`) and
  `ipc:pi.settings.*` (`handlers/pi-sdk.ts`) import `electron`. They mostly need `app.getPath`, which still
  has to be confirmed per file.
- `worker-manager-pool.ts` forks with `utilityProcess`. `worker-manager.ts` pushes events through
  `mainWindow.webContents.send`.
- `session-preview-process.ts` uses `utilityProcess`.
- `config-store.ts` is `electron-store`. `secret-store.ts` uses `safeStorage`.

Altogether 56 files under `src/main` import `electron`. The headless build must pull in only the
session/model/settings/workspace-fs subset of them.

## 4. Headless host (`pi-host`)

### 4.1 Process layout

```
pi-host (node ≥ 22, no Electron)
├─ RemoteGateway            ← unchanged (src/main/remote/*)
├─ NodeRemoteHost           ← new RemoteHostPort; shares logic with remote-host-electron.ts
├─ WorkerManager            ← existing pool with a NodeChildTransport + an event sink instead of BrowserWindow
│   └─ node worker.mjs × N  ← unchanged worker, PI_WORKER_STDIO=1
├─ SessionPreview           ← same, forked as a node child
└─ HandlerRegistry          ← registry.ts without ipcMain; only "host-scoped" handlers registered (§5.3)
```

### 4.2 Changes in the existing code (prep refactors, no behaviour change on desktop)

1. **Worker transport:** add `createNodeChildTransport()` to `src/main/worker-transport.ts`. It does
   `spawn(process.execPath, [worker.mjs])` with `PI_WORKER_STDIO=1`, and its framing is identical to the WSL
   transport (factor out the shared stdout-frame parser). `kind: 'node'`. The pool picks a transport through
   an injected factory instead of importing `utilityProcess` directly.
2. **Event sink:** `WorkerManager.setMainWindow(win)` becomes `setEventSink({ appEvent, workerExit,
   workerFatal, … })`. Desktop passes a window-backed sink, and `pi-host` passes one that feeds the remote tap
   (`setRemoteTapSink`) and, in phase 2, desktop clients.
3. **Registry:** `registerHandler` stores into the map and calls `ipcMain.handle` only when an
   `ipcMain` binder has been installed. `invokeHandler` already exists and becomes the only entry point on
   `pi-host`.
4. **Store and secrets:** introduce a small `KeyValueStore` interface. Desktop backs it with `electron-store`.
   `pi-host` backs it with `conf` (the Node base of electron-store) in `$PI_HOST_HOME/config.json`. Secrets on
   `pi-host` are 0600 files under `$PI_HOST_HOME/secrets/`, the same fallback
   `remote-host-electron.ts` already uses for `remote-host.key`. An optional
   `PI_HOST_KEY_FILE` / systemd `LoadCredential=` lets operators keep the host key outside the data dir.
5. **Port split:** move the bodies of `createElectronRemoteHost()` that do not need Electron (fork,
   sessionTree, listDir, gitDiff, usage, commands, capabilities) into
   `src/main/remote/host-port-common.ts`. Electron and Node ports then differ only in name/version, storage,
   secrets, renderer notifications (no-ops headless) and `trustedProjects`.
6. **Headless bundle guard:** add a build entry `out/host/pi-host.mjs` and a test that fails if the headless
   graph resolves `electron`. That keeps window, tray, browser and updater code out for good. Electron stays
   a build-time-only dependency of the desktop entry.

A shortcut to consider for a spike only: alias `electron` to a Node shim. It makes things run quickly, but
it hides real coupling as silent no-ops, so it should not ship.

### 4.3 What pi-host does not do

No window, tray, built-in browser, notifications, ASR, auto-update, desktop widgets or theme. Browser-tool
capabilities that need the Electron browser are reported `available: false` in `capability.list`, through
the existing `CapabilityRowSchema.reason`.

### 4.4 Workspaces on a headless host

Desktop authorizes projects by intersecting the "trusted projects" (recent projects) with the gateway
whitelist (`RemoteGateway.allowedProjects`). `pi-host` has no recent-projects list. Its trusted set is
exactly the configured project list:

```
pi-host project add /srv/repos/blog
pi-host project list | remove <path>
```

A later admin method (phase 3) lets a paired admin client add folders under a configured root
(`--workspace-root /srv/repos`). Nothing outside that root is ever offered.

### 4.5 CLI, packaging, running

```
pi-host serve [--port 1111] [--bind 0.0.0.0] [--advertise ws://nas.lan:1111 …] [--home ~/.pi-host]
pi-host pair            # prints pidesk://pair#… plus a terminal QR (qrcode already a dep), waits for one device
pi-host devices [revoke|remove|role <id> viewer|operator|admin]
pi-host project add|remove|list
pi-host doctor          # node version, pi agent dir, auth providers present, port reachability
```

- `--advertise` is needed because `hostAddresses()` filters out `docker*`, `br-*` and `veth*` interfaces
  (correct on a desktop). Inside a NAS container it would advertise nothing useful.
- The pi agent dir is the normal `~/.pi/agent` of the service user, or `PI_CODING_AGENT_DIR`. API keys,
  `models.json`, skills and `settings.json` live there and are read by the worker exactly as on desktop.
  Keeping one copy on the server is the "convergence" the issue asks for (§8).
- Ship it as an npm tarball / GitHub release asset (`pi-host-<ver>.tgz` with `pi-host.mjs`, `worker.mjs` and
  chunks, running on the system Node) plus a Dockerfile (node:22-slim, volume for `~/.pi` and the projects,
  `EXPOSE 1111`) and a sample systemd unit.
- The worker bundle is the same `worker.mjs` the WSL path already syncs into distros, so no second build
  of the agent side is needed.

## 5. Protocol: reuse and extensions

### 5.1 Reused unchanged

The handshake, `SecureChannel`, frames, pairing link, the full phone method table, the timeline/patch model
and `ui.*`. The Android client and `NodeRemoteClient` therefore work against `pi-host` from day one. That is
phase 1's acceptance test.

### 5.2 Compatibility rules (the schemas are `.strict()`)

`HelloParamsSchema.caps`, `HelloResultSchema` and `Hs2PayloadSchema.role` are all strict zod objects/enums,
and the Kotlin side mirrors them. A new field or role value sent to an old peer is a parse failure, not an
ignored extra. So:

- Keep `PROTOCOL_VERSION = 1`. Gate every addition on `features` (host → client, already a free
  `string[]`) and on a new optional `caps.features: string[]` (client → host). **First** ship a host that
  accepts that optional field, and only later clients that send it.
- Never put a new role value into `hs2`. Desktop clients get extra **scopes** (`admin`) through a new
  optional `scopes` field in `host.hello`'s result, sent only when the client advertised `caps.features`
  containing `scopes`. Phones keep seeing `viewer` / `operator`.
- Add a fixture to `packages/shared/remote/fixtures` for every new method, as for the existing ones, so the
  Kotlin round-trip test keeps the two in step.

### 5.3 What a desktop client needs beyond the phone table

The desktop renderer is built on ~199 `ipc:*` invoke channels plus the `ipc:events` AppEvent stream, not on
Turn patches. There are two ways to drive it remotely:

| Option | Parity | Cost | Risk |
|---|---|---|---|
| A. Renderer speaks the phone protocol (new remote session view) | Low: phone feature set | New UI path, duplicated rendering | Low |
| **B. Host-scoped IPC tunnel**: desktop main forwards an explicit allowlist of `ipc:*` channels to the host and re-emits the host's AppEvents | High: same renderer | Main-side router + channel classification | IPC handlers become network-reachable, so allowlist + schemas are mandatory |

**Recommendation: B, with a curated allowlist.** It keeps the renderer almost unchanged, which matters while
the per-session renderer state redesign is in flight elsewhere. It also gives the "UI shell" the issue
describes. Concretely:

- New feature `ipcTunnel` with two additions:
  - method `ipc.invoke { channel, body }` → `{ result }`, scope `operator` or `admin` per channel.
  - event `app.event { event }`: raw AppEvents for sessions the client subscribed to with
    `session.subscribeRaw { sessionKey }`. The hub's existing subscriber sets and per-connection buffering
    are reused. `stream-delta-coalescer` on the worker already merges token deltas.
- A single table `packages/shared/ipc-scope.ts` classifies each channel as one of:
  - `host`: sessions, prompts, models, thinking, context, skills/extension catalog, pi settings, workspace-fs,
    git, usage, commands.
  - `client`: theme, window, panels, background, browser, dialogs, notifications, updater, ASR, links, and
    reveal/open-in-editor.
  - `host-admin`: models.json, auth/provider sign-in, skill install/remove, extension enable, MCP config,
    project whitelist.
  - `unsupported-remote`: for example the terminal in phase 2.

  `scripts/tests/ipc-channel-sync.test.mjs` is extended so an unclassified channel fails CI. The host
  re-validates every tunneled body with the handler's zod schema. Channels registered without
  `registerHandlerWithSchema` get a schema before they join the allowlist.
- The integrated terminal (`handlers/terminal.ts`) is a PTY stream. It stays `unsupported-remote` until a
  later phase adds a `pty.*` stream method. A remote shell is the highest-risk capability, so it gets
  admin scope and its own opt-in.

### 5.4 Files and attachments

- Viewing remote files: the existing `workspace-fs` channels (and the phone's `file.list` / `file.search`)
  already go through the host and are confined to the workspace root.
- Composer attachments and pasted images: the client uploads them with the existing `attachment.upload`
  (10 MB cap, stored in the host's clipboard-attachment dir) and the prompt references the host path. This
  is the cheap answer to "let the agent see this file on my laptop" when talking to a remote host.

## 6. Local files: where do tools run?

### 6.1 Options

**T1. Server execution (opencode-style).** The worker and all tools run on the host. This is simple and
consistent: git panel, diff review, file tree, extensions, MCP stdio servers and LSP all see the same
filesystem as the agent. Client files are only reachable as uploaded attachments. This is what the
commenter dislikes.

**T2. Split execution (client-side tool bridge).** The worker (LLM loop, keys, skills, session file) runs on
the host, and the built-in tools run on the client. This is technically feasible: pi SDK 1.0.2 tools take
pluggable operations (`BashOperations`, `ReadOperations`, `EditOperations`, `WriteOperations`,
`GrepOperations`, `FindOperations`, `LsOperations` in `dist/core/tools/*.d.ts`, documented "for example
SSH"). The worker would build its tools with operations that RPC back over the gateway to an "exec agent"
in the client's desktop main. But it leaks in many places:

- Only built-in tools are covered. Extensions, MCP stdio servers, skill scripts, `@` file search, the git
  panel, `review.diff` and context preview all read the **worker's** filesystem.
- Skills live on the host. The model reads `SKILL.md` by absolute host path through the `read` tool, which
  would now hit the client. Every tool would need path routing ("agent dir → host, everything else →
  client").
- When the client disconnects mid-turn, the running agent loses its hands. It needs abort/resume semantics
  that the protocol does not have.
- Security inverts. The host, and whoever controls it or the model, can run arbitrary commands on every
  connected client. Each client would need its own workspace whitelist and per-command policy.

**T3. Execution follows the workspace (multi-host).** Every machine that has files to work on runs a host.
pi Desktop already is one (the phone gateway), and a Linux box runs `pi-host`. A desktop client connects to
any number of hosts. Its sidebar lists workspaces per host, and its own machine is the `local` host with
today's code path. Tools run where the workspace lives. The NAS adds shared config and keys (§8), so
switching machines does not fragment the environment.

### 6.2 Recommendation

**T3, with T1 as its building block.** Do not build T2 now.

- T3 is literally what the commenter describes (各个电脑安装服务端, each reading its own local files), and
  it keeps everything that reads the filesystem consistent.
- T1 (remote workspace on the NAS) is the same machinery seen from the other side, so nothing is wasted.
- The real gap left by T1 + T3 is "use NAS-held keys while working on laptop files". The LLM relay in §8.3
  closes it without moving tools.
- Revisit T2 only if users need a remote brain with local hands **and** accept that only built-in tools
  follow. In that case ship it as an explicit per-workspace "client tools" mode, built on the operations
  interfaces, behind admin consent on both ends.

## 7. Auth, pairing and key storage

| Item | Desktop host (today) | `pi-host` | Desktop as client (new) |
|---|---|---|---|
| Host static key | safeStorage, fallback 0600 file in userData | 0600 file `$PI_HOST_HOME/secrets/host.key` or `PI_HOST_KEY_FILE` / systemd credential | n/a |
| Client static key | n/a | n/a | One X25519 key per client install, sealed with safeStorage in the config store. Per-host records `{hostId, hostPub, endpoints, deviceId, scopes}` |
| Pairing | QR in Settings | `pi-host pair` prints link + terminal QR. One device per token, 5 min | "Add host → paste link" (or scan the QR shown by another desktop) |
| Device records | `remote.devices` | Same `AuthStore` in `config.json` | — |

- **Pinning:** the client learns `hostPub` from the link and the IK handshake authenticates both sides, so
  a MITM on the LAN cannot impersonate the host. The channel is end-to-end encrypted even over plain
  `ws://`.
- **Scopes:** `viewer` < `operator` < `admin` (admin only via `host.hello.scopes`, §5.2). The device that
  ran the first `pi-host pair --admin` is admin. Other devices default to operator, the same as today's
  `registerDevice` default. Admin covers `host-admin` IPC channels, pairing new devices remotely, the
  project whitelist and settings writes.
- **Endpoint policy:** `isAllowedEndpoint` accepts only `ws://` to private, CGNAT and MagicDNS hosts. Keep
  that as the default and recommend Tailscale for off-LAN use (`tailnet.ts` already advertises MagicDNS).
  Allow other hostnames only through an explicit per-host "I know this is a public address" toggle on the
  client. The encryption does not depend on TLS, but exposing the port invites handshake floods. The
  existing per-IP limit is 20 failures/min. A WS reverse proxy with TLS is supported, not required.
- **Revocation:** unchanged (`revokeDevice` closes live sockets with 4006). Add `pi-host devices revoke`.
- **Threat-model delta**, to add to `doc/THREAT-MODEL.md` when phase 2 lands. The IPC tunnel makes some
  desktop handlers network-reachable for paired devices. Mitigations: the allowlist (§5.3), schema
  validation on the host, scope checks, and the workspace-root confinement the handlers already enforce.
  Paths in tunneled bodies are checked against the host's whitelisted projects before any handler runs.

## 8. Settings and skills convergence

### 8.1 Classify state

| Class | Examples (StoreSchema / pi files) | Lives on |
|---|---|---|
| Client-local UI | theme, iconTheme, customTheme, background, windowBounds, panelWidths, rightPanelPrefs/Order, language, timeline display prefs | Each client, never synced |
| Host runtime | `~/.pi/agent/settings.json` (cacheWarming…), `models.json`, `auth.json`, skills dirs, extensions, `skillOverrides`, `extensionOverrides`, `extensionConfigs`, `sessionCapabilities`, model routers, MCP config | The host that runs the workspace |
| Per-client presentation of host things | `skillPresentation` (alias/icon) | Host (shared), so every client shows the same names |

The classification goes into code next to `StoreSchema` (one `scope` per key) so new keys must choose one.

### 8.2 Remote workspaces (T1): nothing to sync

When the desktop works on a `pi-host` workspace, there is one copy of the host-runtime state and it is on the
host. The desktop's Settings pages read and write it through `host-admin` channels, so skills, models and
keys "converge" by construction. Other clients learn about changes through the existing `settings.changed`
event, extended with more keys behind a feature flag. Client-local UI prefs stay local.

### 8.3 Local workspaces with a shared hub (T3): later phase

For "my laptop works on its own files but uses the NAS's skills and keys", the NAS acts as a **config hub**
for local hosts:

- **Skills:** the hub publishes a manifest of skill bundles (`name`, `sha256`, `files[]`). A client pulls
  them into a managed dir (`~/.pi/agent/skills/.hub/<hostId>/…`) that pi already scans, and never touches
  user-authored skills. This is one-way hub → client. Local edits to hub skills are refused or forked into a
  local copy.
- **Settings:** a per-key revision counter on the hub, last writer wins, and only keys classified "host
  runtime, shareable". Clients opt in per key group.
- **Keys:** they never leave the hub by default. Instead the client starts an **LLM relay**: a loopback
  HTTP proxy (127.0.0.1, random port, random bearer) in desktop main. It forwards provider requests and
  streams over the existing encrypted channel (`llm.request` method + `llm.chunk` events), and the hub calls
  upstream with its keys. Local `models.json` gets a generated provider pointing at the relay. This
  satisfies "all LLM requests go through the server" without moving tools. Subscription/OAuth logins are a
  product/ToS question (§11).

## 9. Desktop: switching between local and remote hosts

- **Host registry** (client config): `hosts: [{ id, name, hostPub, endpoints[], deviceId, scopes, lastSeen }]`
  plus the implicit `local`.
- **Workspace → host binding:** a workspace id becomes `(hostId, path)`, with `local` as the default so every
  existing id keeps working. The sidebar groups projects by host and shows a connection badge.
- **Main-side router** (`src/main/host-router.ts`): every renderer `invoke(channel, body)` is routed by
  `ipc-scope` and by the workspace/session in the body.
  - `client` channels run locally.
  - `host` channels go to the in-process handler for `local`, or to `ipc.invoke` on the owning host's
    connection.
  - Raw AppEvents from remote hosts are re-emitted on `ipc:events` tagged with `hostId`, and the renderer's
    session keys become host-qualified.
  - The renderer keeps calling the same `window.api.invoke`. This is the reason for option B.
- **Renderer impact (kept small):** a host picker and "Add host" dialog, badges, host-qualified session keys,
  and disabled affordances for `client`-only actions on remote paths (reveal in Explorer, open in editor,
  integrated terminal in phase 2). Coordinate with the per-session renderer state redesign. The only
  contract it needs is "session key may be host-qualified".
- **Reconnect:** reuse the phone's model. The connection drops on any crypto or protocol error, the client
  reconnects with backoff and re-opens subscribed sessions. Raw AppEvents have no cursor, so after a
  reconnect the client re-reads `session.getMessages` for open sessions. The ring-buffer resume stays a
  phone-protocol feature.
- **Offline host:** its workspaces show as unavailable. Nothing is cached for offline editing.

## 10. Phased plan

Sizes are rough, for one maintainer familiar with the code.

### Phase 0: headless-ready refactors (no user-visible change, ~1 week)

The §4.2 items: node child transport, event sink instead of BrowserWindow, registry without `ipcMain`,
`KeyValueStore` / secrets interfaces, `host-port-common.ts`, and the "headless graph has no `electron`" test.
Done when desktop behaves identically (existing unit, e2e and phone e2e suites green) and a test can boot
`WorkerManager` with the node transport and run one fake-provider turn on Linux CI.

### Phase 1: `pi-host` serving the existing protocol (smallest useful slice, ~1–2 weeks)

- `pi-host serve|pair|devices|project|doctor`, `NodeRemoteHost`, `--advertise`, tarball + Dockerfile +
  systemd unit, docs page.
- The Android app pairs with a NAS and drives sessions there. Keys, skills and models live only on the NAS.
- Done when `NodeRemoteClient` e2e against a real `pi-host` in Linux CI passes (pair, list, open,
  `turn.send` with a stub provider, `ui.respond`, reconnect + resume), and a manual Android check against a
  Docker container succeeds.
- Not in this phase: desktop client, admin scope, IPC tunnel.
- Why this slice first: it is mostly existing code, it gives issue #13's author a working NAS host right
  away (from the phone), and it is the dependency for every later phase.

### Phase 2: desktop as remote client (~3–4 weeks)

- Client identity + host registry + "Add host" (paste link). `caps.features` / `scopes` negotiation.
  `ipcTunnel` (`ipc.invoke`, `session.subscribeRaw`, `app.event`). `ipc-scope.ts` + CI check. Main-side
  router, host-qualified workspace and session keys, minimal renderer affordances.
- Done when a desktop can open a `pi-host` workspace and do the core loop with parity: sidebar, history,
  prompt/steer/abort, model and thinking, extension UI dialogs, file tree/preview, git diff review, context
  stats. The phone and the desktop can share a session on the same host. THREAT-MODEL updated.
- Not in this phase: settings writes, terminal, browser tools on the remote host.

### Phase 3: remote administration (~2 weeks)

- `admin` scope. `host-admin` channels for skills (install/enable/disable), extensions, models.json, provider
  keys, pi settings, project whitelist under `--workspace-root`, remote pairing of further devices.
- The desktop Settings pages operate on the selected host. `settings.changed` fan-out to every client.
- Done when settings and skills changed from one client show up on every other client of that host, which
  meets the issue's item 3 for remote workspaces.

### Phase 4: config hub + LLM relay for local workspaces (~3 weeks)

The §8.3 skill bundles (one-way), opt-in shared settings keys, and the LLM relay over the encrypted channel.
Done when a laptop works on its own files with NAS-held keys and skills, with no API key stored on the
laptop. This meets the commenter's requirement together with the issue's.

### Phase 5: optional, by demand

- Remote PTY (`pty.*`, admin + explicit opt-in).
- Public-address opt-in UX and a reverse-proxy guide.
- Split execution (T2) as an experimental per-workspace "client tools" mode.
- Browser-tool capability on headless via Playwright, if wanted.

## 11. Testing

- Unit: keep using `FakeHost` for gateway logic. Add `NodeRemoteHost` tests with a temp `$PI_HOST_HOME` and
  a temp agent dir.
- e2e: `scripts/remote/dev-host.ts` gains a `--real` mode that boots `pi-host` with a stub model provider.
  `NodeRemoteClient` drives it. Add a Linux CI job, since the headless host is Linux-first.
- Protocol: a new fixture per method/event in `packages/shared/remote/fixtures`, plus the Kotlin round-trip
  test.
- Desktop client: a Playwright smoke that pairs the app with a `pi-host` on loopback and runs one turn.

## 12. Open product questions for the maintainer

None of these has been answered yet. Where phase 1 needs an answer, it uses the recommended default,
marked **Assumed for phase 1**. Phase 2 and later wait for the real answers.

1. **Scope of "UI shell":** is the desktop-as-client (phase 2) needed in the first release, or is "NAS host +
   phone" (phase 1) a useful first release on its own?
   **Assumed for phase 1:** phase 1 ships alone; desktop-as-client waits for this answer.
2. **Local files:** do you agree with "execution follows the workspace" (multi-host + hub) over a client-side
   tool bridge? Is there a concrete case where a remote brain with local hands is required?
   **Assumed for phase 1:** execution follows the workspace; tools run on the host that owns the workspace.
3. **Keys and subscriptions:** may OAuth/subscription sign-ins (not just API keys) be used through the
   NAS by several devices? That may conflict with provider terms. Should the LLM relay be API-key-only?
4. **Multi-user:** is a host single-owner (all paired devices are the same person), or must it separate users
   (own sessions, own keys, own projects)? The current design assumes single-owner.
   **Assumed for phase 1:** single-owner host.
5. **Network exposure:** keep LAN/Tailscale-only as the supported setup, or support exposing the port to
   the internet (and so test reverse proxies and TLS)?
   **Assumed for phase 1:** LAN/Tailscale only; the private-endpoint guard is unchanged.
6. **Distribution:** npm package, Docker image, or both? Which NAS platforms matter (Synology DSM container,
   Unraid, plain Debian)? What is the minimum Node version on them?
   **Assumed for phase 1:** npm package first (system Node ≥ 22.19, the repo's ngines); Docker later.
7. **Terminal on remote hosts:** wanted at all? It is effectively remote shell access for every admin
   device.
   **Assumed for phase 1:** no remote terminal.
8. **Settings sync granularity:** for local workspaces, should hub skills be read-only on clients, or should
   clients be able to push skills back to the hub?
9. **Default port:** keep `47900` (today's gateway default) for `pi-host`, or use something else? The issue's
   1111 is only an example and is configurable either way.
   **Assumed for phase 1:** keep 47900 (`--port` overrides it).
10. **Desktop as host for other desktops:** should a pi Desktop accept desktop clients too (same gateway), or
    should only `pi-host` serve desktop clients?
