import { useState } from "react";
import { applyTheme, getTheme, type Theme } from "../theme";

/** Header theme toggle — mirrors the Settings → Appearance control. */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(() => getTheme());
  const toggle = () => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    setTheme(next);
    applyTheme(next);
    // keep the Settings page control in sync
    window.dispatchEvent(new CustomEvent("llmswitch-theme", { detail: next }));
  };
  return (
    <button
      onClick={toggle}
      title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
      className="rounded-lg px-2 py-1.5 text-sm text-zinc-500 hover:text-white"
    >
      {theme === "dark" ? "☀️" : "🌙"}
    </button>
  );
}
