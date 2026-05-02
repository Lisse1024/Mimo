import type { AppSettings, PetMood } from "./lib/types";
import Live2DAvatar from "./Live2DAvatar";

interface Props {
  settings: AppSettings;
  mood: PetMood;
  variant?: "main" | "preview";
}

const DEFAULT_MODEL_URL = "/live2d/shizuku/shizuku.model3.json";

export default function CharacterAvatar({
  settings,
  mood,
  variant = "main"
}: Props) {
  const modelUrl = settings.avatarLive2DModelUrl?.trim() || DEFAULT_MODEL_URL;

  return <Live2DAvatar modelUrl={modelUrl} mood={mood} variant={variant} />;
}
