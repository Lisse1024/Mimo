import { useEffect, useState } from "react";
import CharacterAvatar from "./CharacterAvatar";
import {
  getSettings,
  saveSettings
} from "./lib/api";
import type { AppSettings } from "./lib/types";

const DEFAULT_MODEL_URL = "/live2d/shizuku/shizuku.model3.json";

const defaultSettings: AppSettings = {
  userName: "朋友",
  petName: "DeskMate",
  newsCategory: "technology",
  newsCountry: "cn",
  tone: "gentle",
  avatarLive2DModelUrl: DEFAULT_MODEL_URL
};

export default function SettingsApp() {
  const [settings, setSettings] = useState<AppSettings>(defaultSettings);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("加载中…");

  async function bootstrap() {
    try {
      const state = await getSettings();
      setSettings({
        ...defaultSettings,
        ...state.settings,
        avatarLive2DModelUrl:
          state.settings.avatarLive2DModelUrl?.trim() || DEFAULT_MODEL_URL
      });
      setMessage("你可以在这里调整 KOC 桌宠的名字、性格和 Live2D 模型地址。修改会自动保存。");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "加载设置失败");
    }
  }

  async function patch(partial: Partial<AppSettings>) {
    setSaving(true);
    try {
      const response = await saveSettings(partial);
      setSettings({
        ...defaultSettings,
        ...response.settings,
        avatarLive2DModelUrl:
          response.settings.avatarLive2DModelUrl?.trim() || DEFAULT_MODEL_URL
      });
      setMessage("已保存。主窗口会立刻使用新的 Live2D 设定。");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }

  useEffect(() => {
    void bootstrap();
  }, []);

  return (
    <div className="settings-root">
      <div className="settings-card">
        <div className="settings-header">
          <div>
            <div className="settings-title">DeskMate 设置</div>
            <div className="settings-subtitle">当前版本只保留 Live2D 角色形象。</div>
          </div>

          <div className="settings-preview">
            <CharacterAvatar settings={settings} mood="happy" variant="preview" />
          </div>
        </div>

        <div className="settings-message">{saving ? "保存中…" : message}</div>

        <div className="settings-grid">
          <label className="settings-field">
            <span>你的称呼</span>
            <input
              value={settings.userName}
              onChange={(e) => setSettings((s) => ({ ...s, userName: e.target.value }))}
              onBlur={() => void patch({ userName: settings.userName.trim() || "朋友" })}
              placeholder="例如 小林"
            />
          </label>

          <label className="settings-field">
            <span>角色名字</span>
            <input
              value={settings.petName}
              onChange={(e) => setSettings((s) => ({ ...s, petName: e.target.value }))}
              onBlur={() => void patch({ petName: settings.petName.trim() || "DeskMate" })}
              placeholder="例如 小水 / Shizuku / DeskMate"
            />
            <small>这个名字会用于桌宠的自我介绍，也会在悬停角色时显示。</small>
          </label>

          <label className="settings-field">
            <span>语气</span>
            <select
              value={settings.tone}
              onChange={(e) => {
                const value = e.target.value as AppSettings["tone"];
                setSettings((s) => ({ ...s, tone: value }));
                void patch({ tone: value });
              }}
            >
              <option value="gentle">温柔</option>
              <option value="playful">活泼</option>
              <option value="efficient">高效</option>
            </select>
          </label>

          <label className="settings-field settings-field-wide">
            <span>Live2D 模型入口地址</span>
            <input
              value={settings.avatarLive2DModelUrl || ""}
              onChange={(e) =>
                setSettings((s) => ({ ...s, avatarLive2DModelUrl: e.target.value }))
              }
              onBlur={() =>
                void patch({
                  avatarLive2DModelUrl:
                    settings.avatarLive2DModelUrl.trim() || DEFAULT_MODEL_URL
                })
              }
              placeholder="例如 /live2d/shizuku/shizuku.model3.json"
            />
            <small>
              模型资源建议放到 <code>apps/desktop/public/live2d/模型名/</code>，
              这里填写入口 <code>.model3.json</code> 路径。当前版本已去掉内置角色和自定义图片模式。
            </small>
          </label>
        </div>

        <div className="settings-section">
          <div className="section-title">Live2D 资源怎么放？</div>
          <ol className="howto-list">
            <li>把 Shizuku 模型内容放进 <code>apps/desktop/public/live2d/shizuku/</code>。</li>
            <li>确保入口文件是 <code>shizuku.model3.json</code>。</li>
            <li>把模型入口填写成 <code>/live2d/shizuku/shizuku.model3.json</code>。</li>
            <li>建议把 <code>live2dcubismcore.min.js</code> 也放到 <code>apps/desktop/public/live2d/</code>。</li>
            <li>如果重启后偶尔首屏没显示，这版会自动重试几次；但本地 runtime 缺失仍会报错。</li>
          </ol>
        </div>
      </div>
    </div>
  );
}
