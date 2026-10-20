/** Light/dark theme for the dashboard. Dark is the default; persisted in localStorage. */

const KEY = "llmswitch_theme";
export type Theme = "dark" | "light";

export function getTheme(): Theme {
  try {
    return localStorage.getItem(KEY) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

export function applyTheme(t: Theme): void {
  try {
    localStorage.setItem(KEY, t);
  } catch { /* ignore */ }
  if (typeof document !== "undefined") {
    document.documentElement.classList.toggle("dark", t === "dark");
  }
}

/** Call once on app boot so the saved theme applies before paint. */
export function initTheme(): Theme {
  const t = getTheme();
  applyTheme(t);
  initPalette();
  return t;
}

/** Colour palette: "default" (zinc) or "bronze" (user-picked warm bronze/gold). */
const PAL_KEY = "llmswitch_palette";
export type Palette = "default" | "bronze";

export function getPalette(): Palette {
  try {
    return localStorage.getItem(PAL_KEY) === "default" ? "default" : "bronze";
  } catch {
    return "bronze";
  }
}

export function applyPalette(p: Palette): void {
  try {
    localStorage.setItem(PAL_KEY, p);
  } catch { /* ignore */ }
  if (typeof document !== "undefined") {
    document.documentElement.classList.toggle("pal-bronze", p === "bronze");
  }
  try {
    window.dispatchEvent(new CustomEvent("llmswitch-palette", { detail: p }));
  } catch { /* ignore */ }
}

export function initPalette(): Palette {
  const p = getPalette();
  applyPalette(p);
  return p;
}

