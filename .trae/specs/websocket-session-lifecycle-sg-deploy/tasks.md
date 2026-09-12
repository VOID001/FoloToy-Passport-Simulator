# WebSocket 会话生命周期修复与 SG 部署 - 实施计划

## Task 1：建立独立修复分支并实现服务端会话回收
- **Status**：`completed`
- **Priority**：high
- **Depends On**：None
- **Description**：
  - 从当前 `origin/main` 创建 `fix/websocket-session-lifecycle`，保留但不暂存无关工作区文件。
  - 为自实现 WebSocket Peer 增加 Ping、Pong 识别、应用层心跳和强制终止能力。
  - 为每个会话维护心跳状态；未在期限内返回应用层 ACK 时终止连接并执行一次幂等清理。
  - 在关闭路径清理心跳 Timer 和 NAT 会话。
- **Acceptance Criteria Addressed**：AC-1、AC-2、AC-5、AC-7
- **Test Requirements**：
  - `rule` TR-1.1：只响应控制帧 Pong、不响应应用层心跳的 Fake Socket 在两个检查周期内被销毁，会话关闭回调只执行一次，新连接随后成功。
  - `rule` TR-1.2：按期返回应用层 ACK 的 Fake Socket 经过两个周期仍保持连接，无超时日志。
  - `rule` TR-1.3：关闭会话后 Timer 不再触发，测试进程可正常退出。
  - `rubric` TR-1.4：生命周期实现质量；1 = 依赖单一 close 事件，3 = 有超时但清理分散，5 = 标准控制帧、单一幂等关闭路径、Timer 与 NAT 资源完整释放；阈值 >= 4；证据为实现和测试。
- **Completion Evidence**：
  - TR-1.1：`node --test test/network.test.mjs` 通过；8 个仅响应控制帧 Pong、不响应应用层心跳的连接均触发 `heartbeat_timeout`，替代连接随后返回 101。
  - TR-1.2：Fake Socket 返回标准 masked Pong 和匹配序号的应用层 ACK，经过多个心跳周期仍未被销毁且无超时事件。
  - TR-1.3：Peer 的 `closed` 守卫保证关闭回调只执行一次；关闭时清除 interval，聚焦测试正常退出。
  - TR-1.4：5/5。实现使用标准 Ping/Pong 和端到端应用心跳、集中 `onClose` 清理、服务关闭兜底终止以及不保持进程存活的 Timer。

## Task 2：增加容量配置和结构化调试字段
- **Status**：`completed`
- **Priority**：high
- **Depends On**：Task 1
- **Description**：
  - 支持 `EMULATOR_NETWORK_MAX_SESSIONS` 和 `EMULATOR_NETWORK_HEARTBEAT_MS`。
  - 对非整数、非正数和越界配置使用默认值。
  - 在接受、拒绝、关闭和心跳超时日志中记录活动会话数、最大会话数、会话 ID、原因和持续时间。
- **Acceptance Criteria Addressed**：AC-3、AC-5、AC-7
- **Test Requirements**：
  - `rule` TR-2.1：默认值、合法值和非法值解析均有确定性测试。
  - `rule` TR-2.2：达到配置上限时返回 503，并记录 `active_sessions` 与 `max_sessions`。
  - `rule` TR-2.3：连接接受、正常关闭和心跳超时日志包含规定字段且计数正确。
  - `rubric` TR-2.4：日志诊断质量；1 = 只有 503，3 = 有计数但缺关联或原因，5 = 全生命周期可按会话关联并直接还原容量变化；阈值 >= 4；证据为日志断言。
- **Completion Evidence**：
  - TR-2.1：配置测试验证默认 `16/30000ms`、合法 `24/45000ms`，以及零、负数、小数、非数字、越界值回退。
  - TR-2.2：聚焦测试确认第 9 个连接返回 503，并记录 `active_sessions=8`、`max_sessions=8`。
  - TR-2.3：接受日志包含 session ID、活动数、上限和心跳周期；关闭日志包含原因、持续时间和释放后的活动数。
  - TR-2.4：5/5。容量变化可从结构化日志直接重建，心跳超时与正常关闭原因可区分。

## Task 3：实现客户端指数退避并补齐运维文档
- **Status**：`completed`
- **Priority**：medium
- **Depends On**：Task 1
- **Description**：
  - 将固定 1 秒重连改为带抖动、最大 30 秒的指数退避。
  - 成功连接后重置退避级别，显式关闭后不再重连。
  - 在部署文档中说明新增环境变量、默认值、日志字段和 Render CLI 查询示例。
- **Acceptance Criteria Addressed**：AC-4、AC-5、AC-7
- **Test Requirements**：
  - `rule` TR-3.1：退避函数在确定随机输入下按指数增长且不超过 30 秒。
  - `rule` TR-3.2：连接成功后下一次失败恢复初始退避，显式关闭不安排 Timer。
  - `rule` TR-3.3：文档中的变量名、默认值和命令与实现一致。
  - `rubric` TR-3.4：客户端恢复策略质量；1 = 固定高频重试，3 = 指数退避但不可测或无抖动，5 = 可测、带抖动、有上限、成功重置且关闭语义明确；阈值 >= 4；证据为实现、测试和文档。
- **Completion Evidence**：
  - TR-3.1：确定性测试验证最大抖动延迟为 1/2/4/8/16/30/30 秒，最小和中间抖动值符合边界。
  - TR-3.2：Fake WebSocket 测试验证连续失败递增、连接成功后回到 1 秒级别、显式关闭取消待执行 Timer。
  - TR-3.3：`DEPLOYMENT.md` 已记录两个新增变量、范围、默认值、生命周期日志字段和 Render CLI 查询命令。
  - TR-3.4：5/5。退避函数纯函数可测，具备指数增长、抖动、30 秒上限、成功重置和停止取消语义。

## Task 4：全量验证、提交并推送独立分支
- **Status**：`completed`
- **Priority**：high
- **Depends On**：Task 2、Task 3
- **Description**：
  - 运行聚焦测试、完整测试、构建和发布校验。
  - 检查 diff 和暂存列表，确保不包含无关未跟踪文件。
  - 提交并推送 `fix/websocket-session-lifecycle`，记录远端 commit。
- **Acceptance Criteria Addressed**：AC-5、AC-6
- **Test Requirements**：
  - `rule` TR-4.1：`npm test`、`npm run build`、`npm run verify:release` 全部通过。
  - `rule` TR-4.2：提交只包含规格、WebSocket 生命周期、客户端退避、测试和文档相关文件。
  - `rule` TR-4.3：`origin/fix/websocket-session-lifecycle` 指向本地 HEAD。
- **Completion Evidence**：
  - TR-4.1：`npm test` 75/75 通过；`npm run build` 生成 41 个文件；`npm run verify:release` 通过 40 项校验。
  - TR-4.2：提交 `19d5e648664d10bdc910852cc30d79a24b9e9c3d` 仅包含两份规格、`DEPLOYMENT.md`、服务端桥、客户端桥和对应网络测试。
  - TR-4.3：推送后 `git rev-parse HEAD` 与 `git ls-remote origin refs/heads/fix/websocket-session-lifecycle` 均为 `19d5e648664d10bdc910852cc30d79a24b9e9c3d`。

## Task 5：将修复 commit 部署到 SG 并验证
- **Status**：`completed`
- **Priority**：high
- **Depends On**：Task 4
- **Description**：
  - 使用 `render deploys create srv-dagc4im7bikc73a8bvrg --commit <SHA> --wait` 显式部署分支 commit。
  - 确认部署状态、实例启动、健康检查与 WebSocket 握手。
  - 查询 SG 新实例日志，确认新增容量字段和会话关闭/回收行为；确认 Oregon 服务未触发部署。
- **Acceptance Criteria Addressed**：AC-6、AC-7
- **Test Requirements**：
  - `rule` TR-5.1：SG 部署状态为 `live`，部署 commit 与修复分支 HEAD 一致。
  - `rule` TR-5.2：SG `/healthz` 返回 200，WebSocket 连接可成功建立。
  - `rule` TR-5.3：新实例日志包含活动会话数和上限；受控失活连接可被回收。
  - `rule` TR-5.4：Oregon 服务最新部署记录未因本任务变化。
  - `rubric` TR-5.5：生产验证质量；1 = 只看到部署成功，3 = 有健康检查但无生命周期证据，5 = commit、区域、健康、握手、回收日志和非目标服务状态均有证据；阈值 >= 4；证据为 Render CLI、HTTP 和日志输出。
- **Completion Evidence**：
  - TR-5.1：SG 部署 `dep-dagfv7f40ujc73f1olp0` 状态为 `live`，运行 commit `6ea4b0f684ea6da185cdc091e2e266a9c9116fa1`。
  - TR-5.2：`https://folotoy-passport-simulator-sg.onrender.com/healthz` 返回 HTTP 200；受控探针 WebSocket 握手返回 101。
  - TR-5.3：失活探针会话 `3656f38b-a113-4600-bd6c-be009fe2b342` 在 60003ms 后记录 `heartbeat_type=application`、`reason=heartbeat_timeout`，活动数从 2 降至 1；健康探针回复 2 次应用 ACK 并保持连接 70 秒。
  - TR-5.4：Oregon 服务仍运行部署 `dep-dagc2iuk1f9s73aos4q0` 和原 commit `250db1dda8baea21d112dba5226745e4d733226d`。
  - TR-5.5：5/5。已核对 commit、Singapore 区域、健康检查、握手、代理控制帧行为、端到端应用心跳回收、健康会话续租和 Oregon 未变更。
