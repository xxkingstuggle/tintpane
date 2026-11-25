# 项目指引

## 项目定位
为已启用的 Chromium PWA 窗口更新页面主题色的 Manifest V3 扩展。

## 如何运行
在 Chrome 打开 chrome://extensions，启用开发者模式并加载仓库的 extension/ 目录；无需构建。

## 技术栈
JavaScript、HTML、CSS 与 Chrome Extension Manifest V3 API。

## 目录与约定
扩展源码和 manifest 在 `extension/`（保持免构建直接加载）；零依赖静态检查与 `node:test` 单元测试位于 `tests/`，根目录 `package.json` 严禁引入外部依赖。功能边界、设置继承规则与检查命令以 `README.md` 为准。

## 当前状态与下一步
保持 `extension/siteConfig.js` 作为弹窗、后台与内容脚本共用的纯逻辑层；所有改动需通过 `node tests/static-check.mjs` 与 `node --test tests/*.test.mjs` 验证，并在需要时于真实 Chromium PWA 窗口完成手工确认。
