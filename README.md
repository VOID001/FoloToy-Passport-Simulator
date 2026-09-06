# FoloToy AI Passport 模拟器

[![FoloToy AI Passport 模拟器演示](./public/assets/demo/folotoy-emu.gif)](./public/assets/demo/folotoy-emu.mp4)

> 点击可观看视频！

在浏览器中运行 FoloToy AI Passport 的 ESP32-C3 固件。项目基于
ESP-EMU v0.42.0、WebAssembly 和 QEMU，直接模拟开发板外设，普通固件无需为浏览器单独适配。

默认固件来自 [`FoloToy/ai-passport`](https://github.com/FoloToy/ai-passport)
的 `c73254e2` 提交。

## 模拟器说明

目前支持：

- ST7789P3 屏幕
- UP、DOWN、OK 和 POWER 按键
- 扬声器和麦克风
- ESP32-C3 Wi-Fi、TCP、UDP、DNS 和 ICMP
- CPU 寄存器、UART 和网络检查器
- 本地固件上传和 FoloToy 社区固件导入

页面内置“音乐钥匙扣”“答案之书”和“FoloToy 官方 Demo”三个固件。

按键也可使用键盘操作：

| 设备按键 | 键盘 |
| --- | --- |
| UP | `↑` |
| DOWN | `↓` |
| OK | `Enter` |
| POWER | `P` |

声音需要先点击页面上的“声音”。麦克风需要单独授权，并且只能在
`localhost` 或 HTTPS 页面使用。

## 必要依赖

- Node.js 20 或更高版本
- npm
- 支持 WebAssembly、Web Worker 和 Web Audio 的现代浏览器，推荐最新版 Chrome 或 Edge
- Docker，可选，仅用于容器部署

项目没有第三方 npm 运行依赖，WASM 运行时和示例固件已经包含在仓库中。

## 本地运行

```bash
npm run prepare:emulator
npm start
```

打开 <http://127.0.0.1:4190>。

`prepare:emulator` 会检查固件、WASM 文件和开发板 ABI。日常开发确认文件没有变化后，
也可以直接执行 `npm start`。

如需让局域网设备访问：

```bash
HOST=0.0.0.0 PORT=4190 npm start
```

## 固件

点击“上传固件”可选择本地 `.bin` 文件，或粘贴
`https://ai-passport.folotoy.cn/plays/` 下的玩法详情链接。

本地开发命令 `npm start` 会启用本地文件入口。`dist/` 发布包和 Docker
镜像默认关闭该入口，只允许从 FoloToy 社区加载经过服务端校验的固件。

本地固件需要满足以下条件：

- ESP32-C3 Full Flash 合并镜像
- 从地址 `0x0` 写入
- 不超过 8 MiB
- 包含 bootloader、分区表、应用和所需资源

上传的本地固件只保存在当前页面中，刷新后会恢复默认固件。

如需显式覆盖本地固件策略，可设置：

```bash
EMULATOR_ALLOW_LOCAL_FIRMWARE_UPLOAD=1 node server.mjs  # 启用
EMULATOR_ALLOW_LOCAL_FIRMWARE_UPLOAD=0 npm start        # 关闭
```

## 生产部署

先生成并校验 `dist/`：

```bash
npm test
npm run build
npm run verify:release
```

直接运行：

```bash
cd dist
HOST=0.0.0.0 PORT=4190 npm start
```

Docker 部署：

```bash
docker build -t ai-passport-emulator .
docker run --rm -p 4190:4190 ai-passport-emulator
```

健康检查地址为 `/healthz`。线上建议在反向代理层配置 HTTPS，并允许
`/api/emulator-network` 的 WebSocket 升级。

## 开发

主要目录和文件：

- `public/`：页面、样式和浏览器端运行代码
- `public/wasm/`：ESP-EMU WASM 和开发板外设模拟
- `server.mjs`：静态资源、社区固件接口和健康检查
- `network-bridge.mjs`：虚拟 Wi-Fi 网络桥
- `test/`：Node.js 单元测试
- `tools/`：构建和发布校验脚本

常用命令：

```bash
npm start                # 启动开发服务
npm test                 # 运行测试
npm run build            # 构建 dist/
npm run verify:release   # 校验发布文件
npm run start:dist       # 运行 dist/ 版本
```

前端没有额外构建步骤，修改 `public/` 后刷新浏览器即可。

## 已知限制

- CW2017 电量计尚未模拟，官方 Demo 会显示 `Battery [FAIL]`
- BLE 控制器尚未模拟，固件进入 BLE ROM 代码时会暂停并提示不支持
- 低功耗行为与真实硬件不完全一致
- 网络只支持 IPv4，不转发分片数据包
- 默认禁止访问内网、回环和保留地址

仅在可信的本地开发环境中，可允许模拟器访问内网：

```bash
EMULATOR_NETWORK_ALLOW_PRIVATE=1 npm start
```
