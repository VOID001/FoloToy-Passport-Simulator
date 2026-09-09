# WebSocket 会话生命周期修复与 SG 部署 - 产品需求文档

## 概述
- **摘要**：修复模拟器网络桥的 WebSocket 会话长期占位问题，增强容量配置、结构化日志和客户端重连策略，并通过独立 Git 分支部署到新加坡 Render 服务。
- **目的**：避免少量旧连接耗尽全局会话槽位，使 `503 session_limit` 可自动恢复且能从日志快速定位。
- **目标用户**：在线使用 AI Passport 模拟器的用户，以及负责 Render 服务诊断和发布的维护者。

## 目标
- 服务端主动检测并回收失活 WebSocket 会话。
- 会话上限可配置且配置错误时安全回退。
- 日志能够直接回答当前连接数、容量、关闭原因和回收原因。
- 客户端连接失败后使用有上限的指数退避，避免持续刷日志。
- 修复从独立分支推送，并将该分支的明确 commit 部署到 Singapore Render 服务。

## 非目标
- 不改变网络桥的私网目标访问策略。
- 不引入用户认证、计费或跨实例共享会话状态。
- 不永久修改 SG Render 服务当前跟踪的 `main` 分支。
- 不部署到 Oregon Render 服务。
- 不清理或提交工作区中与本次修复无关的未跟踪文件。

## 背景与上下文
- SG 服务 `srv-dagc4im7bikc73a8bvrg` 位于 `singapore`，当前从 `main` 自动部署。
- 线上实例在 `2026-09-09T04:31:48Z` 至 `04:44:48Z` 接受了 8 个 WebSocket 会话，之后没有产生 `network_bridge_session_closed`，并从 `04:53:41Z` 起持续返回 `503 session_limit`。
- 当前服务端上限硬编码为 8；会话只在 socket `close` 或 `error` 时删除，没有主动心跳。
- 当前客户端每次断开后固定等待 1 秒重连，多个客户端会持续放大拒绝日志。

## 功能需求
- **FR-1**：服务端必须周期性发送标准 WebSocket Ping，并在客户端未及时返回 Pong 时强制终止连接和释放会话。
- **FR-2**：客户端正确返回 Pong 或连接持续健康时，心跳不得误杀会话。
- **FR-3**：WebSocket 最大会话数和心跳周期必须可通过环境变量配置；缺失或非法配置必须使用有文档的安全默认值。
- **FR-4**：连接接受、容量拒绝、正常关闭和心跳超时日志必须包含可关联的会话 ID、当前活动会话数和最大会话数；关闭日志必须包含原因和持续时间。
- **FR-5**：客户端重连必须采用带抖动、有上限的指数退避，并在成功连接后重置退避级别。
- **FR-6**：部署文档必须描述新增配置、默认值、日志字段以及 Render 排障命令。
- **FR-7**：实现必须提交并推送到独立分支，再使用该分支 commit 显式部署到 SG 服务。

## 非功能需求
- **NFR-1**：会话清理必须幂等，不得重复关闭底层 NAT Flow、Timer 或 Socket。
- **NFR-2**：心跳 Timer 必须在会话关闭时释放，并不得阻止 Node.js 进程退出。
- **NFR-3**：不得削弱 WebSocket 握手校验、同源校验或默认私网访问限制。
- **NFR-4**：代码遵循仓库现有 ESM、Node Test 和结构化 JSON 日志风格，不新增运行时依赖。
- **NFR-5**：部署后健康检查、WebSocket 握手和关键日志必须提供可复核证据。

## 约束
- **技术**：Node.js 20+；现有自实现 WebSocket 帧处理；Render CLI 2.26.0。
- **部署**：目标仅为 `FoloToy-Passport-Simulator-SG`，服务 ID `srv-dagc4im7bikc73a8bvrg`。
- **版本控制**：基于当前 `origin/main` 创建 `fix/websocket-session-lifecycle`；只暂存本任务文件。
- **工作区**：现有 `.trae/specs/network-benchmark-runtime`、`firmware/`、测速工具和其他未跟踪文件均视为用户工作，不得修改或回退。
- **依赖**：推送依赖 GitHub SSH 权限；部署和日志验证依赖已授权的 Render CLI。

## 假设
- 浏览器会按照 WebSocket 标准自动响应服务端 Ping。
- 默认最大会话数采用 16，在不显著扩大单实例资源风险的前提下缓解正常并发；运维可通过环境变量调整。
- 默认心跳周期采用 30 秒；连续一个周期未收到 Pong 的连接会在下一次检查时终止，即最迟约 60 秒回收。
- SG 服务继续跟踪 `main`，本次使用 `render deploys create --commit` 部署独立分支 commit。

## 验收标准

### AC-1：失活会话自动回收
- **Type**：`rule`
- **Given**：一个已接受的 WebSocket 客户端不响应服务端 Ping。
- **When**：经过两个心跳检查周期。
- **Then**：服务端强制终止连接、清理 NAT 会话和 Timer，并释放容量槽位。
- **Pass Condition**：自动化测试观察到超时日志、一次关闭回调、活动数减一，随后新连接可被接受。
- **Evidence**：Node Test 输出及结构化日志断言。

### AC-2：健康会话不会被误回收
- **Type**：`rule`
- **Given**：客户端在心跳期限内返回 Pong。
- **When**：经过至少两个心跳检查周期。
- **Then**：连接保持活动且会话槽位不发生异常变化。
- **Pass Condition**：自动化测试确认 socket 未被销毁，且无心跳超时日志。
- **Evidence**：Node Test 输出。

### AC-3：容量配置与日志可诊断
- **Type**：`rule`
- **Given**：使用默认、合法自定义或非法会话容量配置启动服务。
- **When**：连接被接受、达到上限、关闭或心跳超时。
- **Then**：服务采用正确容量，并输出包含会话 ID、活动数、上限、原因和持续时间的结构化日志。
- **Pass Condition**：配置解析测试和四类日志断言全部通过；非法值回退默认值。
- **Evidence**：Node Test 输出和日志 fixture。

### AC-4：客户端退避受控
- **Type**：`rule`
- **Given**：WebSocket 连续连接失败。
- **When**：客户端安排后续重连。
- **Then**：延迟按指数增长、包含抖动并受最大值限制；成功连接后恢复初始延迟。
- **Pass Condition**：确定性测试验证增长、上限、抖动边界和成功重置。
- **Evidence**：Node Test 输出。

### AC-5：安全与发布回归
- **Type**：`rule`
- **Given**：修复完成。
- **When**：运行完整测试、构建和发布校验。
- **Then**：现有网络、安全、固件和页面行为无回归。
- **Pass Condition**：`npm test`、`npm run build`、`npm run verify:release` 全部退出码为 0。
- **Evidence**：命令输出。

### AC-6：独立分支与 SG 部署
- **Type**：`rule`
- **Given**：所有本地验收通过。
- **When**：提交、推送和部署。
- **Then**：远端存在独立修复分支，SG 服务运行该分支 commit，Oregon 服务未被部署。
- **Pass Condition**：远端分支 commit 与部署 commit 一致；SG 部署状态为 `live`；`/healthz` 返回 200；新实例日志包含新增会话字段。
- **Evidence**：Git、Render deploy、HTTP 健康检查和 Render 日志输出。

### AC-7：调试与维护质量
- **Type**：`rubric`
- **Dimension**：故障定位清晰度、生命周期健壮性、配置可操作性和实现可维护性。
- **Scale**：1-5
- **Anchors**：1 = 仅提高上限且仍会泄漏；3 = 有超时回收但日志或测试不足；5 = 标准心跳、幂等清理、容量配置、关联日志、受控退避、完整回归和部署证据齐全。
- **Pass Threshold**：>= 4
- **Evidence**：代码、测试、文档、生产日志和独立审查。

## 开放问题
- 无。
