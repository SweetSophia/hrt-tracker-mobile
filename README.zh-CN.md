# HRT Tracker Mobile

[English](./README.md) · 简体中文

**HRT Tracker Mobile** 是 [Oyama's HRT Tracker](https://github.com/xunxunProjects/Oyama-s-HRT-Tracker) 的独立 Android 移植版，由 Askarys 的 [SweetSophia](https://github.com/SweetSophia) 维护。它把上游的记录工具和激素水平模型直接带到手机上。应用及所需资源随 APK 一起安装，首次启动也可以离线使用，无需服务器、账号、局域网或 Tailscale 连接。

## Android 版功能

- **本机记录。** 支持女性化和男性化模式，可以记录用药和化验结果。记录加密保存在本机的 SQLCipher 数据库中，数据库密钥由 Android Keystore 保护。
- **图表与用药计划。** 查看随时间变化的激素水平估算，与化验结果对照，并使用用药计划、库存和方案试算功能。
- **可迁移的备份。** 通过 Android 系统文件选择器保存或还原包含两种模式的完整备份。兼容的备份文件可以用于迁移网页版或早期 Android 预览版的记录。完整备份文件中的健康记录可直接读取。
- **手机操作与九种语言。** 支持 Android 返回操作，界面适配手机屏幕。可选简体中文、繁体中文、粤语、英语、日语、韩语、土耳其语、俄语和乌克兰语。

## 下载 Android 版

[下载已签名的 Android 安装包（1.0.1）](https://github.com/SweetSophia/hrt-tracker-mobile/releases/download/android-v1.0.1/hrt-tracker-1.0.1.apk) · [查看英文和简体中文发布说明](https://github.com/SweetSophia/hrt-tracker-mobile/releases/tag/android-v1.0.1)

HRT Tracker 支持 Android 7.0 及以上版本。已安装 1.0.0 或 **HRT Tracker** 签名测试版的用户可以直接更新。Android 包名为 `org.askarys.hrttracker`。iPhone 版计划在后续阶段推出。

## 构建与贡献

使用 [`.node-version`](./.node-version) 中指定的 Node 版本、JDK 21 和 Android SDK Platform 36。在仓库根目录构建调试预览版：

```sh
npm ci
npm run android:sync
npm run build:mobile:offline-beta
./android/gradlew -p android -PofflineBeta :app:assembleOfflineBeta
```

预览版 APK 位于 `android/app/build/outputs/apk/offlineBeta/app-offlineBeta.apk`，以调试包名 `org.askarys.hrttracker.spike.offlinebeta` 安装。以上命令只构建调试预览目标；正式版目标（`org.askarys.hrttracker`）的对齐与签名步骤见上文构建和签名指南。运行 `npm test` 执行单元测试，运行 `npm run test:e2e:mobile` 在浏览器中验证移动版构建。

欢迎参与 Android 测试、报告问题、翻译、反馈无障碍问题，也欢迎贡献设计、文档和代码。请参阅[贡献指南](./CONTRIBUTING.md)或[提交问题](https://github.com/SweetSophia/hrt-tracker-mobile/issues/new/choose)。反馈问题时请使用示例记录。

## 上游项目与致谢

Android 版通过 Capacitor 打包共享的 React 界面和 TypeScript 模型。存储、文件选择和应用生命周期由 Android 平台适配层处理，便于审查和移植网页版的后续改动。集成过程记录在[上游同步日志](./docs/upstream/SYNC-LOG.md)中。

[Oyama's HRT Tracker](https://github.com/xunxunProjects/Oyama-s-HRT-Tracker) 是上游网页项目。网页版、桌面版、云备份和分享链接的说明见其 README。原始记录工具和药代动力学模型来自 LaoZhong-Mihari 的 [HRT-Recorder](https://github.com/LaoZhong-Mihari/HRT-Recorder-online) 与[药代动力学模型仓库](https://github.com/LaoZhong-Mihari/HRT-Recorder-PKcomponent-Test)。参阅[算法说明](./Algorithm%20Explanation.md)和 [MIT 许可证](./LICENSE)。

### Docker

如需自行部署网页端，请参阅[上游 Docker 指南](https://github.com/xunxunProjects/Oyama-s-HRT-Tracker#docker)。

> **仅供参考。** 应用展示的模型估算值可能与实际测得的激素水平不同。请与医生讨论治疗决定。
