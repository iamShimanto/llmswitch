import { useEffect, useState } from "react";
import { getAdminKey, setAdminKey } from "./api";
import { LanguageProvider, LanguageToggle, useLang } from "./i18n";
import { initTheme } from "./theme";
import { ThemeToggle } from "./components/ThemeToggle";
import Home from "./pages/Home";
import Providers from "./pages/Providers";
import Usage from "./pages/Usage";
import Keys from "./pages/Keys";
import Playground from "./pages/Playground";
import Inspector from "./pages/Inspector";
import Costs from "./pages/Costs";
import Explain from "./pages/Explain";
import Analytics from "./pages/Analytics";
import Batches from "./pages/Batches";
import Quotas from "./pages/Quotas";
import Sessions from "./pages/Sessions";
import Settings from "./pages/Settings";
import Leaderboard from "./pages/Leaderboard";
import Limits from "./pages/Limits";
import Logs from "./pages/Logs";
import Mcp from "./pages/Mcp";
import Media from "./pages/Media";
import Memory from "./pages/Memory";
import Models from "./pages/Models";
import Onboarding from "./pages/Onboarding";
import Plugins from "./pages/Plugins";
import Profile from "./pages/Profile";
import Radar from "./pages/Radar";
import Relay from "./pages/Relay";
import Runtime from "./pages/Runtime";
import Search from "./pages/Search";
import Translators from "./pages/Translators";
import Webhooks from "./pages/Webhooks";
// P10-E sibling batch pages
import Activity from "./pages/Activity";
import Agents from "./pages/Agents";
import Skills from "./pages/Skills";
import ApiManager from "./pages/ApiManager";
import Audit from "./pages/Audit";
import Combos from "./pages/Combos";
import Cache from "./pages/Cache";
import Changelog from "./pages/Changelog";
import Chaos from "./pages/Chaos";
import Compression from "./pages/Compression";
import Orchestration from "./pages/Orchestration";
import Context from "./pages/Context";
import Conversations from "./pages/Conversations";
import Discovery from "./pages/Discovery";
import FreeTiers from "./pages/FreeTiers";
import Health from "./pages/Health";

interface Page {
  id: string;
  labelKey: string;
}
interface Section {
  id: string;
  labelKey: string;
  pages: Page[];
}

// Sibling batch (P10-E) pages are wired below into these sections.
const SECTIONS: Section[] = [
  {
    id: "overview",
    labelKey: "nav.overview",
    pages: [
      { id: "home", labelKey: "nav.overview" },
      { id: "onboarding", labelKey: "nav.onboarding" },
      { id: "analytics", labelKey: "nav.analytics" },
      { id: "activity", labelKey: "nav.activity" },
    ],
  },
  {
    id: "providers",
    labelKey: "nav.providers",
    pages: [
      { id: "providers", labelKey: "nav.providers" },
      { id: "models", labelKey: "nav.models" },
      { id: "leaderboard", labelKey: "nav.leaderboard" },
      { id: "radar", labelKey: "nav.radar" },
      { id: "media", labelKey: "nav.media" },
      { id: "translators", labelKey: "nav.translators" },
      { id: "discovery", labelKey: "nav.discovery" },
      { id: "freetiers", labelKey: "nav.freeTiers" },
      { id: "explain", labelKey: "nav.routing" },
    ],
  },
  {
    id: "tools",
    labelKey: "nav.sectionTools",
    pages: [
      { id: "playground", labelKey: "nav.playground" },
      { id: "inspector", labelKey: "nav.inspector" },
      { id: "search", labelKey: "nav.search" },
      { id: "mcp", labelKey: "nav.mcp" },
      { id: "compression", labelKey: "nav.compression" },
      { id: "context", labelKey: "nav.context" },
      { id: "conversations", labelKey: "nav.conversations" },
    ],
  },
  {
    id: "management",
    labelKey: "nav.sectionManagement",
    pages: [
      { id: "keys", labelKey: "nav.apiKeys" },
      { id: "apimanager", labelKey: "nav.apiManager" },
      { id: "sessions", labelKey: "nav.sessions" },
      { id: "quotas", labelKey: "nav.quotas" },
      { id: "limits", labelKey: "nav.limits" },
      { id: "batches", labelKey: "nav.batches" },
      { id: "costs", labelKey: "nav.costs" },
      { id: "usage", labelKey: "nav.usage" },
      { id: "webhooks", labelKey: "nav.webhooks" },
      { id: "audit", labelKey: "nav.audit" },
      { id: "combos", labelKey: "nav.combos" },
      { id: "orchestration", labelKey: "nav.orchestration" },
      { id: "agents", labelKey: "nav.agents" },
    ],
  },
  {
    id: "system",
    labelKey: "nav.sectionSystem",
    pages: [
      { id: "settings", labelKey: "nav.settings" },
      { id: "runtime", labelKey: "nav.runtime" },
      { id: "profile", labelKey: "nav.profile" },
      { id: "logs", labelKey: "nav.logs" },
      { id: "health", labelKey: "nav.health" },
      { id: "cache", labelKey: "nav.cache" },
      { id: "relay", labelKey: "nav.relay" },
      { id: "plugins", labelKey: "nav.plugins" },
      { id: "memory", labelKey: "nav.memory" },
      { id: "changelog", labelKey: "nav.changelog" },
      { id: "chaos", labelKey: "nav.chaos" },
      { id: "skills", labelKey: "nav.skills" },
    ],
  },
];

const PRIMARY: Page[] = [
  { id: "home", labelKey: "nav.overview" },
  { id: "providers", labelKey: "nav.providers" },
  { id: "models", labelKey: "nav.models" },
  { id: "playground", labelKey: "nav.playground" },
  { id: "keys", labelKey: "nav.apiKeys" },
  { id: "usage", labelKey: "nav.usage" },
  { id: "analytics", labelKey: "nav.analytics" },
  { id: "settings", labelKey: "nav.settings" },
];
const PRIMARY_IDS = new Set(PRIMARY.map((p) => p.id));
const ADVANCED_SECTIONS: Section[] = SECTIONS.map((sec) => ({
  ...sec,
  pages: sec.pages.filter((p) => !PRIMARY_IDS.has(p.id)),
})).filter((sec) => sec.pages.length > 0);

type TabId = string;

function AppInner() {
  const { t } = useLang();
  const [tab, setTab] = useState<TabId>("home");
  const [adminKey, setAdminKeyState] = useState(getAdminKey());
  const [showKey, setShowKey] = useState(false);
  useEffect(() => {
    initTheme();
    // After an OAuth browser round-trip the gateway redirects here with
    // ?oauth=<provider>; land on the Providers tab so the connected badge
    // is visible, then clean the query string.
    const params = new URLSearchParams(window.location.search);
    if (["antigravity", "claude", "codex"].includes(params.get("oauth") ?? "")) {
      setTab("providers");
      window.history.replaceState(null, "", window.location.pathname);
    }
  }, []);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [open, setOpen] = useState<Record<string, boolean>>(() => {
    // On small screens start with sections collapsed (except Overview) so the
    // nav doesn't push page content far below the fold.
    const narrow = typeof window !== "undefined" && window.innerWidth < 768;
    return Object.fromEntries(SECTIONS.map((s) => [s.id, narrow ? s.id === "overview" : true]));
  });

  const toggle = (id: string) => setOpen((o) => ({ ...o, [id]: !o[id] }));

  return (
    <div className="min-h-screen">
      <header className="border-b border-zinc-800">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2 px-4 py-4">
          <div className="text-lg font-bold">
            ⚡ LLMSwitch <span className="text-sm font-normal text-zinc-500">{t("common.aiGateway")}</span>
          </div>
          <div className="flex items-center gap-1">
            <LanguageToggle />
            <ThemeToggle />
            <button
              onClick={() => setShowKey((v) => !v)}
              title={t("header.adminKeyTitle")}
              className="rounded-lg px-2 py-1.5 text-sm text-zinc-500 hover:text-white"
            >
              🔑
            </button>
            {showKey && (
              <input
                type="password"
                value={adminKey}
                placeholder={t("header.adminKeyPlaceholder")}
                onChange={(e) => {
                  setAdminKeyState(e.target.value);
                  setAdminKey(e.target.value);
                }}
                className="w-32 rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs"
              />
            )}
          </div>
        </div>
        <nav className="mx-auto max-w-6xl px-4 pb-3">
          <div className="flex flex-wrap items-center gap-1.5">
            {PRIMARY.map((page) => (
              <button
                key={page.id}
                onClick={() => setTab(page.id)}
                className={`rounded-full border px-3.5 py-1.5 text-sm ${
                  tab === page.id
                    ? "border-zinc-600 bg-zinc-800 font-semibold text-white"
                    : "border-zinc-800 text-zinc-400 hover:text-white"
                }`}
              >
                {t(page.labelKey)}
              </button>
            ))}
            <button
              onClick={() => setShowAdvanced((v) => !v)}
              className="rounded-full border border-dashed border-zinc-700 px-3.5 py-1.5 text-sm text-zinc-400 hover:text-white"
            >
              {t("nav.advanced")} {showAdvanced ? "▾" : "▸"}
            </button>
          </div>
          {showAdvanced && (
          <div className="mt-3 flex flex-wrap gap-4 border-t border-zinc-800/60 pt-3">
            {ADVANCED_SECTIONS.map((s) => (
              <div key={s.id} className="min-w-36">
                <button
                  onClick={() => toggle(s.id)}
                  className="mb-1 flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-zinc-500 hover:text-zinc-300"
                >
                  <span>{open[s.id] ? "▾" : "▸"}</span> {t(s.labelKey)}
                </button>
                {open[s.id] && (
                  <div className="flex flex-col gap-0.5">
                    {s.pages.map((page) => (
                      <button
                        key={page.id}
                        onClick={() => setTab(page.id)}
                        className={`rounded-lg px-3 py-1.5 text-left text-sm ${
                          tab === page.id ? "bg-zinc-800 text-white" : "text-zinc-400 hover:text-white"
                        }`}
                      >
                        {t(page.labelKey)}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
          )}
        </nav>
      </header>
      <main key={adminKey} className="mx-auto max-w-6xl px-4 py-8">
        {tab === "home" && <Home />}
        {tab === "onboarding" && <Onboarding />}
        {tab === "analytics" && <Analytics />}
        {tab === "activity" && <Activity />}
        {tab === "providers" && <Providers />}
        {tab === "models" && <Models />}
        {tab === "leaderboard" && <Leaderboard />}
        {tab === "radar" && <Radar />}
        {tab === "media" && <Media />}
        {tab === "translators" && <Translators />}
        {tab === "discovery" && <Discovery />}
        {tab === "freetiers" && <FreeTiers />}
        {tab === "explain" && <Explain />}
        {tab === "playground" && <Playground />}
        {tab === "inspector" && <Inspector />}
        {tab === "search" && <Search />}
        {tab === "mcp" && <Mcp />}
        {tab === "compression" && <Compression />}
        {tab === "context" && <Context />}
        {tab === "conversations" && <Conversations />}
        {tab === "keys" && <Keys />}
        {tab === "apimanager" && <ApiManager />}
        {tab === "sessions" && <Sessions />}
        {tab === "quotas" && <Quotas />}
        {tab === "limits" && <Limits />}
        {tab === "batches" && <Batches />}
        {tab === "costs" && <Costs />}
        {tab === "usage" && <Usage />}
        {tab === "webhooks" && <Webhooks />}
        {tab === "audit" && <Audit />}
        {tab === "combos" && <Combos />}
        {tab === "orchestration" && <Orchestration />}
        {tab === "agents" && <Agents />}
        {tab === "settings" && <Settings />}
        {tab === "runtime" && <Runtime />}
        {tab === "profile" && <Profile />}
        {tab === "logs" && <Logs />}
        {tab === "health" && <Health />}
        {tab === "cache" && <Cache />}
        {tab === "relay" && <Relay />}
        {tab === "plugins" && <Plugins />}
        {tab === "memory" && <Memory />}
        {tab === "changelog" && <Changelog />}
        {tab === "chaos" && <Chaos />}
        {tab === "skills" && <Skills />}
      </main>
    </div>
  );
}

export default function App() {
  return (
    <LanguageProvider>
      <AppInner />
    </LanguageProvider>
  );
}
