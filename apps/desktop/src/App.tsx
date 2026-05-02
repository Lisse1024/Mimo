import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import PetApp from "./PetApp";
import SettingsApp from "./SettingsApp";

// 不再依赖 query 参数判断当前是主窗口还是设置窗口。
// 直接读取 Tauri 窗口 label 更稳：main => 桌宠，settings => 设置页。
export default function App() {
  const [view, setView] = useState<"pet" | "settings">("pet");

  useEffect(() => {
    const label = getCurrentWindow().label;
    setView(label === "settings" ? "settings" : "pet");
  }, []);

  return view === "settings" ? <SettingsApp /> : <PetApp />;
}
