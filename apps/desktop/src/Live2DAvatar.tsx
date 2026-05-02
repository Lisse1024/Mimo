import { useEffect, useRef, useState } from "react";
import type { PetMood } from "./lib/types";

interface Props {
  modelUrl: string;
  mood: PetMood;
  variant?: "main" | "preview";
}

declare global {
  interface Window {
    Live2DCubismCore?: unknown;
    PIXI?: unknown;
  }
}

const DEFAULT_MODEL_URL = "/live2d/shizuku/shizuku.model3.json";
const LOCAL_CUBISM_CORE_URL = "/live2d/live2dcubismcore.min.js";
const REMOTE_CUBISM_CORE_URL =
  "https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js";

const MOUTH_PARAM_ID = "ParamMouthOpenY";
const LEFT_EYE_PARAM_ID = "ParamEyeLOpen";
const RIGHT_EYE_PARAM_ID = "ParamEyeROpen";
const LEFT_EYE_SMILE_PARAM_ID = "ParamEyeLSmile";
const RIGHT_EYE_SMILE_PARAM_ID = "ParamEyeRSmile";
const EYE_BALL_X_PARAM_ID = "ParamEyeBallX";
const EYE_BALL_Y_PARAM_ID = "ParamEyeBallY";

// 常见的眼球 / 高光 / 白眼球 part / drawable ID。
// 这批名字不要求模型完全一致；后面还会和运行时枚举出的 ID 做并集。
const EYE_VISUAL_ID_HINTS = [
  "PartEyeBallL",
  "PartEyeBallR",
  "PartEyeBallL0",
  "PartEyeBallR0",
  "PartPupilL",
  "PartPupilR",
  "PartIrisL",
  "PartIrisR",
  "PartEyeWhiteL",
  "PartEyeWhiteR",
  "PartEyeHighlightL",
  "PartEyeHighlightR",
  "PartEyeHiLightL",
  "PartEyeHiLightR",
  "PartHighlightL",
  "PartHighlightR",
  "D_EYE_BALL_L",
  "D_EYE_BALL_R",
  "D_EYE_HIGHLIGHT_L",
  "D_EYE_HIGHLIGHT_R",
  "D_EYE_WHITE_L",
  "D_EYE_WHITE_R"
];

const EYE_VISUAL_ID_PATTERN =
  /(eyeball|pupil|iris|highlight|hilight|glint|specular|eye[_-]?white|sclera|瞳|虹彩|白目|ハイライト)/i;

let cubismCoreLoadingPromise: Promise<void> | null = null;

function loadScript(src: string) {
  return new Promise<void>((resolve, reject) => {
    const existed = document.querySelector<HTMLScriptElement>(
      `script[data-live2d-core="${src}"]`
    );

    if (existed) {
      if (window.Live2DCubismCore) {
        resolve();
        return;
      }

      existed.addEventListener("load", () => resolve(), { once: true });
      existed.addEventListener("error", () => reject(new Error(`加载失败：${src}`)), {
        once: true
      });
      return;
    }

    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.dataset.live2dCore = src;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`加载失败：${src}`));
    document.head.appendChild(script);
  });
}

async function ensureCubismCore() {
  if (window.Live2DCubismCore) return;

  if (!cubismCoreLoadingPromise) {
    cubismCoreLoadingPromise = (async () => {
      try {
        await loadScript(LOCAL_CUBISM_CORE_URL);
      } catch {
        await loadScript(REMOTE_CUBISM_CORE_URL);
      }

      if (!window.Live2DCubismCore) {
        throw new Error(
          "Live2D Core 没有加载成功。请把 live2dcubismcore.min.js 放到 apps/desktop/public/live2d/ 目录。"
        );
      }
    })().catch((error) => {
      cubismCoreLoadingPromise = null;
      throw error;
    });
  }

  return cubismCoreLoadingPromise;
}

function moodToMotionGroup(mood: PetMood): string | null {
  switch (mood) {
    case "idle":
      return "Idle";
    case "listening":
      return "FlickUp";
    case "thinking":
      return "Flick3";
    case "speaking":
      return "Tap";
    case "alert":
      return "Tap";
    case "happy":
      return "FlickUp";
    case "sleepy":
    case "sleeping":
      return null;
    default:
      return "Idle";
  }
}

function waitForVisibleSize(host: HTMLDivElement, maxFrames = 60) {
  return new Promise<void>((resolve) => {
    let count = 0;

    const check = () => {
      if (host.clientWidth > 0 && host.clientHeight > 0) {
        resolve();
        return;
      }

      count += 1;
      if (count >= maxFrames) {
        resolve();
        return;
      }

      window.requestAnimationFrame(check);
    };

    check();
  });
}

function getCoreModel(model: any) {
  return model?.internalModel?.coreModel;
}

function setParamValue(model: any, id: string, value: number) {
  const coreModel = getCoreModel(model);
  if (!coreModel?.setParameterValueById) return;
  coreModel.setParameterValueById(id, value);
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function randomInt(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function waitMs(ms: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, ms));
}

function stopAllMotions(model: any) {
  const motionManager = model?.internalModel?.motionManager;
  motionManager?.stopAllMotions?.();
}

function isSleepMood(mood: PetMood) {
  return mood === "sleepy" || mood === "sleeping";
}

function uniqueStrings(values: unknown[]) {
  const set = new Set<string>();

  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      set.add(value.trim());
    }
  }

  return [...set];
}

function collectStringArray(candidate: any) {
  if (!Array.isArray(candidate)) return [];
  return candidate.filter((item) => typeof item === "string");
}

function collectPartIds(model: any) {
  const coreModel = getCoreModel(model);
  if (!coreModel) return [] as string[];

  const directPartIds = collectStringArray(coreModel.getPartIds?.());
  const arrayPartIds = [
    ...collectStringArray(coreModel.partIds),
    ...collectStringArray(coreModel._partIds),
    ...collectStringArray(coreModel.parts?.ids),
    ...collectStringArray(coreModel.parts?.partIds)
  ];

  const indexedPartIds: string[] = [];
  const count =
    typeof coreModel.getPartCount === "function"
      ? Number(coreModel.getPartCount())
      : Number(coreModel.partCount ?? coreModel.parts?.count ?? 0);

  if (count > 0) {
    for (let index = 0; index < count; index += 1) {
      const id = coreModel.getPartId?.(index) ?? coreModel.parts?.ids?.[index];
      if (typeof id === "string") {
        indexedPartIds.push(id);
      }
    }
  }

  return uniqueStrings([...directPartIds, ...arrayPartIds, ...indexedPartIds]);
}

function collectDrawableIds(model: any) {
  const internalModel = model?.internalModel;
  if (!internalModel) return [] as string[];

  return uniqueStrings([
    ...collectStringArray(internalModel.drawableIds),
    ...collectStringArray(internalModel.drawables?.ids),
    ...collectStringArray(internalModel.drawables?.drawableIds),
    ...collectStringArray(internalModel.coreModel?.drawableIds),
    ...collectStringArray(internalModel.coreModel?.drawables?.ids)
  ]);
}

function setPartOpacityById(model: any, id: string, opacity: number) {
  const coreModel = getCoreModel(model);
  if (!coreModel) return false;

  if (typeof coreModel.setPartOpacityById === "function") {
    coreModel.setPartOpacityById(id, opacity);
    return true;
  }

  const index =
    typeof coreModel.getPartIndex === "function"
      ? Number(coreModel.getPartIndex(id))
      : Array.isArray(coreModel.parts?.ids)
        ? coreModel.parts.ids.indexOf(id)
        : -1;

  if (index < 0) return false;

  if (typeof coreModel.setPartOpacityByIndex === "function") {
    coreModel.setPartOpacityByIndex(index, opacity);
    return true;
  }

  if (Array.isArray(coreModel.partOpacities) && index < coreModel.partOpacities.length) {
    coreModel.partOpacities[index] = opacity;
    return true;
  }

  if (Array.isArray(coreModel._partOpacities) && index < coreModel._partOpacities.length) {
    coreModel._partOpacities[index] = opacity;
    return true;
  }

  if (Array.isArray(coreModel.parts?.opacities) && index < coreModel.parts.opacities.length) {
    coreModel.parts.opacities[index] = opacity;
    return true;
  }

  return false;
}

function setDrawableOpacityById(model: any, id: string, opacity: number) {
  const internalModel = model?.internalModel;
  const drawableIds = collectDrawableIds(model);
  const index = drawableIds.indexOf(id);
  if (!internalModel || index < 0) return false;

  let changed = false;

  const opacitiesArrays = [
    internalModel.drawables?.opacities,
    internalModel.drawables?.vertexOpacities,
    internalModel.coreModel?.drawables?.opacities
  ];

  for (const target of opacitiesArrays) {
    if (Array.isArray(target) && index < target.length) {
      target[index] = opacity;
      changed = true;
    }
  }

  const meshGroups = [
    internalModel.meshes,
    internalModel.drawables?.meshes,
    model.meshes,
    model.children
  ];

  for (const meshes of meshGroups) {
    if (Array.isArray(meshes) && meshes[index] && "alpha" in meshes[index]) {
      meshes[index].alpha = opacity;
      changed = true;
    }
  }

  return changed;
}

function buildCdi3Url(modelUrl: string) {
  return modelUrl.replace(/\.model3\.json(\?.*)?$/, ".cdi3.json$1");
}

async function findEyeVisualIdsFromCdi3(modelUrl: string) {
  const cdi3Url = buildCdi3Url(modelUrl);
  if (cdi3Url === modelUrl) return [] as string[];

  try {
    const response = await fetch(cdi3Url, { cache: "no-store" });
    if (!response.ok) return [];

    const text = await response.text();
    const matches = new Set<string>();

    const idRegexes = [
      /"(?:Id|ID|id)"\s*:\s*"([^"]*(?:EyeBall|Pupil|Iris|Highlight|HiLight|EyeWhite|Sclera)[^"]*)"/gi,
      /"([^"]*(?:EyeBall|Pupil|Iris|Highlight|HiLight|EyeWhite|Sclera)[^"]*)"/gi
    ];

    for (const regex of idRegexes) {
      for (const match of text.matchAll(regex)) {
        const candidate = match[1]?.trim();
        if (candidate && EYE_VISUAL_ID_PATTERN.test(candidate)) {
          matches.add(candidate);
        }
      }
    }

    return [...matches];
  } catch {
    return [];
  }
}

async function detectSleepEyeVisualIds(model: any, modelUrl: string) {
  const partIds = collectPartIds(model);
  const drawableIds = collectDrawableIds(model);
  const cdi3Ids = await findEyeVisualIdsFromCdi3(modelUrl);

  return uniqueStrings([
    ...EYE_VISUAL_ID_HINTS,
    ...partIds.filter((id) => EYE_VISUAL_ID_PATTERN.test(id)),
    ...drawableIds.filter((id) => EYE_VISUAL_ID_PATTERN.test(id)),
    ...cdi3Ids
  ]);
}

export default function Live2DAvatar({
  modelUrl,
  mood,
  variant = "main"
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const appRef = useRef<any>(null);
  const modelRef = useRef<any>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const lastPlayedGroupRef = useRef<string>("");
  const disposedRef = useRef(false);
  const moodRef = useRef<PetMood>(mood);
  const ambientTimerRef = useRef<number | null>(null);
  const blinkStartedAtRef = useRef<number>(0);
  const nextBlinkAtRef = useRef<number>(performance.now() + randomInt(2200, 4200));
  const wasEyeControlledRef = useRef(false);
  const hiddenEyeVisualIdsRef = useRef<string[]>([]);
  const eyeVisualsHiddenRef = useRef(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const mountSeqRef = useRef(0);

  function clearAmbientTimer() {
    if (ambientTimerRef.current) {
      window.clearTimeout(ambientTimerRef.current);
      ambientTimerRef.current = null;
    }
  }

  function setSleepEyeVisualsHidden(model: any, hidden: boolean) {
    const targetOpacity = hidden ? 0 : 1;
    const ids = hiddenEyeVisualIdsRef.current;
    if (!model || ids.length === 0) {
      eyeVisualsHiddenRef.current = hidden;
      return;
    }

    for (const id of ids) {
      setPartOpacityById(model, id, targetOpacity);
      setDrawableOpacityById(model, id, targetOpacity);
    }

    eyeVisualsHiddenRef.current = hidden;
  }

  function applySleepOverrides(model: any, now = performance.now()) {
    if (!model) return;

    const currentMood = moodRef.current;
    const sleeping = currentMood === "sleeping";
    const sleepy = currentMood === "sleepy";

    if (!sleeping && !sleepy) {
      if (wasEyeControlledRef.current) {
        wasEyeControlledRef.current = false;
        setParamValue(model, LEFT_EYE_PARAM_ID, 1);
        setParamValue(model, RIGHT_EYE_PARAM_ID, 1);
        setParamValue(model, LEFT_EYE_SMILE_PARAM_ID, 0);
        setParamValue(model, RIGHT_EYE_SMILE_PARAM_ID, 0);
        setParamValue(model, EYE_BALL_X_PARAM_ID, 0);
        setParamValue(model, EYE_BALL_Y_PARAM_ID, 0);
      }

      if (eyeVisualsHiddenRef.current) {
        setSleepEyeVisualsHidden(model, false);
      }
      return;
    }

    wasEyeControlledRef.current = true;

    // 这次不再只靠开眼参数。
    // sleepy / sleeping 都直接隐藏眼球、高光、白眼球相关 part / drawable，
    // 这样即使模型内部还有 motion 或 eyeBlink 抢参数，也不会再从眼皮后面漏蓝色。
    if (!eyeVisualsHiddenRef.current) {
      setSleepEyeVisualsHidden(model, true);
    }

    const eyeOpen = sleeping
      ? 0
      : clamp(0.045 + Math.sin(now / 1800) * 0.006, 0.035, 0.055);

    setParamValue(model, LEFT_EYE_PARAM_ID, eyeOpen);
    setParamValue(model, RIGHT_EYE_PARAM_ID, eyeOpen);
    setParamValue(model, LEFT_EYE_SMILE_PARAM_ID, 0);
    setParamValue(model, RIGHT_EYE_SMILE_PARAM_ID, 0);
    setParamValue(model, EYE_BALL_X_PARAM_ID, 0);
    setParamValue(model, EYE_BALL_Y_PARAM_ID, 0);

    const internalModel = model?.internalModel;
    if (internalModel?.focusController) {
      internalModel.focusController.x = 0;
      internalModel.focusController.y = 0;
      if ("targetX" in internalModel.focusController) {
        internalModel.focusController.targetX = 0;
      }
      if ("targetY" in internalModel.focusController) {
        internalModel.focusController.targetY = 0;
      }
    }
  }

  async function playMotionForMood(nextMood: PetMood, force = false) {
    const model = modelRef.current;
    if (!model) return;

    const group = moodToMotionGroup(nextMood);
    const motionKey = `${nextMood}:${group ?? "none"}`;

    if (!force && lastPlayedGroupRef.current === motionKey) {
      return;
    }

    lastPlayedGroupRef.current = motionKey;

    if (!group) {
      stopAllMotions(model);
      applySleepOverrides(model);
      return;
    }

    if (eyeVisualsHiddenRef.current) {
      setSleepEyeVisualsHidden(model, false);
    }

    try {
      await model.motion(group, 0);
    } catch {
      if (group !== "Idle") {
        try {
          await model.motion("Idle", 0);
        } catch {
          // 静默忽略
        }
      }
    }
  }

  function getBlinkOpenFactor(now: number) {
    const currentMood = moodRef.current;

    if (isSleepMood(currentMood)) {
      return 1;
    }

    if (!blinkStartedAtRef.current && now >= nextBlinkAtRef.current) {
      blinkStartedAtRef.current = now;
    }

    if (!blinkStartedAtRef.current) {
      return 1;
    }

    const progress = (now - blinkStartedAtRef.current) / 180;
    if (progress >= 1) {
      blinkStartedAtRef.current = 0;
      nextBlinkAtRef.current = now + randomInt(2600, 5200);
      return 1;
    }

    return Math.abs(progress - 0.5) * 2;
  }

  function scheduleAmbientMotion() {
    clearAmbientTimer();

    const currentMood = moodRef.current;
    if (currentMood !== "idle") {
      return;
    }

    const delay = randomInt(7000, 12000);

    ambientTimerRef.current = window.setTimeout(async () => {
      if (disposedRef.current || !modelRef.current) return;

      try {
        await modelRef.current.motion(Math.random() < 0.6 ? "FlickUp" : "Flick3", 0);
      } catch {
        // 静默忽略一次随机动作失败
      }

      scheduleAmbientMotion();
    }, delay);
  }

  useEffect(() => {
    moodRef.current = mood;
    void playMotionForMood(mood);

    if (mood === "idle") {
      scheduleAmbientMotion();
    } else {
      clearAmbientTimer();
      if (modelRef.current && isSleepMood(mood)) {
        applySleepOverrides(modelRef.current);
      }
    }
  }, [mood]);

  useEffect(() => {
    disposedRef.current = false;
    const mountSeq = ++mountSeqRef.current;

    async function mountModel() {
      const host = containerRef.current;
      if (!host) return;

      const effectiveModelUrl = modelUrl?.trim() || DEFAULT_MODEL_URL;

      setError("");
      setLoading(true);
      host.innerHTML = "";

      await waitForVisibleSize(host);
      await ensureCubismCore();

      const PIXI = await import("pixi.js");
      window.PIXI = PIXI;

      const { Live2DModel } = await import("pixi-live2d-display/cubism4");

      if (disposedRef.current || !containerRef.current || mountSeq !== mountSeqRef.current) return;

      const app = new PIXI.Application({
        width: host.clientWidth || 160,
        height: host.clientHeight || 160,
        backgroundAlpha: 0,
        antialias: true,
        autoStart: true
      });

      appRef.current = app;
      const view = app.view as HTMLCanvasElement;
      view.style.pointerEvents = "none";
      host.appendChild(view);

      let model: any = null;
      let lastError: unknown = null;

      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          model = await (Live2DModel as any).from(effectiveModelUrl);
          break;
        } catch (loadError) {
          lastError = loadError;
          if (attempt < 2) {
            await waitMs(160 * (attempt + 1));
          }
        }
      }

      if (!model) {
        app.destroy(true);
        throw lastError instanceof Error ? lastError : new Error("Live2D 模型加载失败");
      }

      if (disposedRef.current || mountSeq !== mountSeqRef.current) {
        app.destroy(true);
        return;
      }

      modelRef.current = model;
      model.interactive = false;
      app.stage.addChild(model);

      hiddenEyeVisualIdsRef.current = await detectSleepEyeVisualIds(model, effectiveModelUrl);

      const fitModel = () => {
        const shell = containerRef.current;
        const currentApp = appRef.current;
        const currentModel = modelRef.current;
        if (!shell || !currentApp || !currentModel) return;

        const shellWidth = shell.clientWidth || 160;
        const shellHeight = shell.clientHeight || 160;

        currentApp.renderer.resize(shellWidth, shellHeight);

        currentModel.scale.set(1);

        const bounds =
          typeof currentModel.getLocalBounds === "function"
            ? currentModel.getLocalBounds()
            : { x: 0, y: 0, width: currentModel.width || 1, height: currentModel.height || 1 };

        const rawWidth = Math.max(bounds.width || 1, 1);
        const rawHeight = Math.max(bounds.height || 1, 1);

        const widthRatio = variant === "preview" ? 0.72 : 0.88;
        const heightRatio = variant === "preview" ? 0.78 : 0.9;

        const scale = Math.min(
          (shellWidth * widthRatio) / rawWidth,
          (shellHeight * heightRatio) / rawHeight
        );

        currentModel.scale.set(scale);

        const boundsX = bounds.x || 0;
        const boundsY = bounds.y || 0;

        currentModel.x = shellWidth / 2 - (boundsX + rawWidth / 2) * scale;
        currentModel.y =
          (variant === "preview" ? shellHeight * 0.96 : shellHeight * 0.98) -
          (boundsY + rawHeight) * scale;
      };

      const updateExtraParams = () => {
        const currentModel = modelRef.current;
        if (!currentModel) return;

        const currentMood = moodRef.current;
        const now = performance.now();

        applySleepOverrides(currentModel, now);

        if (!isSleepMood(currentMood)) {
          const blinkOpenFactor = getBlinkOpenFactor(now);
          setParamValue(currentModel, LEFT_EYE_PARAM_ID, blinkOpenFactor);
          setParamValue(currentModel, RIGHT_EYE_PARAM_ID, blinkOpenFactor);
        }

        if (currentMood === "speaking") {
          const mouthOpen = 0.18 + Math.abs(Math.sin(now / 80)) * 0.55;
          setParamValue(currentModel, MOUTH_PARAM_ID, clamp(mouthOpen, 0, 1));
        } else if (currentMood === "sleepy") {
          const mouthOpen = 0.02 + Math.abs(Math.sin(now / 520)) * 0.05;
          setParamValue(currentModel, MOUTH_PARAM_ID, clamp(mouthOpen, 0, 0.12));
        } else {
          setParamValue(currentModel, MOUTH_PARAM_ID, 0);
        }
      };

      fitModel();

      const internalModel = model.internalModel;
      const syncSleepEyes = () => {
        if (modelRef.current) {
          applySleepOverrides(modelRef.current);
        }
      };

      internalModel?.on?.("afterMotionUpdate", syncSleepEyes);
      internalModel?.on?.("beforeModelUpdate", syncSleepEyes);
      internalModel?.on?.("afterModelUpdate", syncSleepEyes);

      app.ticker.add(() => {
        updateExtraParams();
      });

      window.requestAnimationFrame(() => {
        fitModel();
        window.setTimeout(fitModel, 120);
        window.setTimeout(fitModel, 360);
      });

      resizeObserverRef.current?.disconnect();
      resizeObserverRef.current = new ResizeObserver(() => {
        fitModel();
      });
      resizeObserverRef.current.observe(host);

      document.fonts?.ready
        ?.then(() => {
          if (!disposedRef.current && mountSeq === mountSeqRef.current) {
            fitModel();
          }
        })
        .catch(() => {
          // 静默忽略字体 ready 检查失败
        });

      await playMotionForMood(moodRef.current, true);
      scheduleAmbientMotion();
      setLoading(false);
    }

    mountModel().catch((err) => {
      setLoading(false);
      setError(err instanceof Error ? err.message : "Live2D 加载失败");
    });

    return () => {
      disposedRef.current = true;
      clearAmbientTimer();
      resizeObserverRef.current?.disconnect();
      resizeObserverRef.current = null;
      modelRef.current = null;
      lastPlayedGroupRef.current = "";
      blinkStartedAtRef.current = 0;
      nextBlinkAtRef.current = performance.now() + randomInt(2200, 4200);
      wasEyeControlledRef.current = false;
      hiddenEyeVisualIdsRef.current = [];
      eyeVisualsHiddenRef.current = false;

      if (appRef.current) {
        appRef.current.destroy(true);
        appRef.current = null;
      }

      if (containerRef.current) {
        containerRef.current.innerHTML = "";
      }
    };
  }, [modelUrl, variant]);

  return (
    <div className={`avatar-live2d-shell ${variant}`} data-state={mood}>
      <div ref={containerRef} className="avatar-live2d-stage" />
      {loading && !error ? <div className="avatar-live2d-error">Live2D 加载中…</div> : null}
      {error ? <div className="avatar-live2d-error">{error}</div> : null}
    </div>
  );
}
