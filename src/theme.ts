// Light / dark / follow-the-system theme, remembered per device.

export type ThemeMode = "dark" | "light" | "system";
const KEY = "tm_theme";

export function getThemeMode(): ThemeMode {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch {
    // storage unavailable (private mode): fall through to the default
  }
  return "dark";
}

function resolve(mode: ThemeMode): "dark" | "light" {
  if (mode !== "system") return mode;
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

export function applyTheme(mode: ThemeMode = getThemeMode()): void {
  document.documentElement.dataset.theme = resolve(mode);
}

export function setThemeMode(mode: ThemeMode): void {
  try {
    localStorage.setItem(KEY, mode);
  } catch {
    // not persisted, still applied for this session
  }
  applyTheme(mode);
}

export function initTheme(): void {
  applyTheme();
  window
    .matchMedia("(prefers-color-scheme: light)")
    .addEventListener("change", () => getThemeMode() === "system" && applyTheme());
}
