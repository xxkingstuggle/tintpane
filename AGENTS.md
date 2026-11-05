# 项目指引

## 项目定位
为已启用的 Chromium PWA 窗口更新页面主题色的 Manifest V3 扩展。

## 如何运行
在 Chrome 打开 chrome://extensions，启用开发者模式并加载仓库的 extension/ 目录；无需构建。

## 技术栈
JavaScript、HTML、CSS 与 Chrome Extension Manifest V3 API。

## 目录与约定
扩展源码和 manifest 在 extension/；功能边界、设置继承规则与检查命令以 README.md 为准。

## 当前状态与下一步
优先保持弹窗与后台共用的站点配置解析逻辑；改动后按 README.md 的 Node 语法检查逐个核对相关脚本。
