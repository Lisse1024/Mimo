import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import App from "./App";
import "./styles.css";

document.body.dataset.view = getCurrentWindow().label === "settings" ? "settings" : "pet";

// 这里不要包 React.StrictMode。
// 当前桌宠包含 Live2D / Tauri 窗口拖动 / ResizeObserver 等强副作用逻辑，
// React 18 开发模式下 StrictMode 会故意触发一次额外挂载/卸载，
// 很容易把 Live2D 首屏初始化打乱，造成要手动刷新几次才出现。
ReactDOM.createRoot(document.getElementById("root")!).render(<App />);
