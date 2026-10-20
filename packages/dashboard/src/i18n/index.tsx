import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { en } from "./en";
import { bn } from "./bn";

export type Lang = "en" | "bn";

const STORAGE_KEY = "llmswitch_lang";

const DICTS: Record<Lang, Record<string, string>> = { en, bn };

interface LangCtx {
  lang: Lang;
  setLang: (l: Lang) => void;
  /** Translate a key. Supports {param} interpolation: t("k", { n: 5 }) */
  t: (key: string, params?: Record<string, string | number>) => string;
}

const Ctx = createContext<LangCtx>({
  lang: "en",
  setLang: () => {},
  t: (key) => key,
});

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) === "bn" ? "bn" : "en";
    } catch {
      return "en";
    }
  });

  const setLang = (l: Lang) => {
    setLangState(l);
    try {
      localStorage.setItem(STORAGE_KEY, l);
    } catch {
      /* ignore */
    }
  };

  useEffect(() => {
    document.documentElement.lang = lang === "bn" ? "bn" : "en";
  }, [lang]);

  const t = (key: string, params?: Record<string, string | number>): string => {
    let s = DICTS[lang][key] ?? DICTS.en[key] ?? key;
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        s = s.replaceAll(`{${k}}`, String(v));
      }
    }
    return s;
  };

  return <Ctx.Provider value={{ lang, setLang, t }}>{children}</Ctx.Provider>;
}

export function useLang(): LangCtx {
  return useContext(Ctx);
}

/** EN | বাং toggle for the header. */
export function LanguageToggle() {
  const { lang, setLang } = useLang();
  return (
    <div
      className="flex items-center rounded-lg border border-zinc-700 text-xs"
      role="group"
      aria-label="Language"
    >
      <button
        onClick={() => setLang("en")}
        className={`rounded-l-lg px-2 py-1.5 ${
          lang === "en" ? "bg-zinc-700 text-white" : "text-zinc-400 hover:text-white"
        }`}
      >
        EN
      </button>
      <button
        onClick={() => setLang("bn")}
        className={`rounded-r-lg px-2 py-1.5 ${
          lang === "bn" ? "bg-zinc-700 text-white" : "text-zinc-400 hover:text-white"
        }`}
      >
        বাং
      </button>
    </div>
  );
}
