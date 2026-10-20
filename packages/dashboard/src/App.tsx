import { useEffect, useState } from "react";
import { authApi, getAdminKey, getSession, setAdminKey, setSession } from "./api";
import Login from "./pages/Login";
import { LanguageProvider, LanguageToggle, useLang } from "./i18n";
import { initTheme } from "./theme";
import { ThemeToggle } from "./components/ThemeToggle";
import Home from "./pages/Home";
import Providers from "./pages/Providers";
import Live from "./pages/Live";
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
import Routing from "./pages/Routing";
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
  { id: "live", labelKey: "nav.live" },
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
      { id: "routing", labelKey: "nav.routing" },
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

// Hash routing: the current page lives in the URL (#/providers) so a browser
// refresh — or sharing the link — stays on the same page instead of
// resetting to the Overview.
const ALL_TAB_IDS: string[] = [];
function collectTabIds(): string[] {
  if (ALL_TAB_IDS.length > 0) return ALL_TAB_IDS;
  for (const p of PRIMARY) ALL_TAB_IDS.push(p.id);
  for (const sec of ADVANCED_SECTIONS) for (const p of sec.pages) ALL_TAB_IDS.push(p.id);
  return ALL_TAB_IDS;
}
function tabFromHash(): string | null {
  const h = window.location.hash.replace(/^#\/?/, "");
  return h && collectTabIds().includes(h) ? h : null;
}
const ADVANCED_SECTIONS: Section[] = SECTIONS.map((sec) => ({
  ...sec,
  pages: sec.pages.filter((p) => !PRIMARY_IDS.has(p.id)),
})).filter((sec) => sec.pages.length > 0);

type TabId = string;

function AppInner() {
  const { t } = useLang();
  const [tab, setTabState] = useState<TabId>(() => tabFromHash() ?? "home");
  const setTab = (id: TabId) => {
    setTabState(id);
    const target = `#/${id}`;
    if (window.location.hash !== target) window.history.pushState(null, "", target);
  };
  useEffect(() => {
    const onHash = () => {
      const t = tabFromHash();
      if (t) setTabState(t);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const [adminKey, setAdminKeyState] = useState(getAdminKey());
  const [authed, setAuthed] = useState<boolean | null>(null);
  useEffect(() => {
    // An admin key in the browser is a full credential — no extra login.
    if (getAdminKey()) {
      setAuthed(true);
      return;
    }
    authApi
      .me()
      .then(() => setAuthed(true))
      .catch(() => setAuthed(false));
  }, []);
  useEffect(() => {
    initTheme();
    // After an OAuth browser round-trip the gateway redirects here with
    // ?oauth=<provider>; land on the Providers tab so the connected badge
    // is visible, then clean the query string.
    const params = new URLSearchParams(window.location.search);
    if (["antigravity", "claude", "codex"].includes(params.get("oauth") ?? "")) {
      setTab("providers");
      window.history.replaceState(null, "", `${window.location.pathname}#/providers`);
    }
  }, []);
  const [mobileNav, setMobileNav] = useState(false);
  const [open, setOpen] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(ADVANCED_SECTIONS.map((sec) => [sec.id, false])),
  );
  // auto-open the section containing the active page
  useEffect(() => {
    const sec = ADVANCED_SECTIONS.find((x) => x.pages.some((p) => p.id === tab));
    if (sec) setOpen((o) => ({ ...o, [sec.id]: true }));
  }, [tab]);

  const toggle = (id: string) => setOpen((o) => ({ ...o, [id]: !o[id] }));

  if (authed === null) {
    return (
      <div className="flex min-h-screen items-center justify-center text-3xl text-zinc-500">⚡</div>
    );
  }
  if (!authed) {
    return <Login onLogin={() => setAuthed(true)} />;
  }

  const go = (id: TabId) => {
    setTab(id);
    setMobileNav(false);
  };

  const navItem = (page: Page) => (
    <button
      key={page.id}
      onClick={() => go(page.id)}
      className={`w-full rounded-lg px-3 py-2 text-left text-sm ${
        tab === page.id ? "bg-zinc-800 font-medium text-white" : "text-zinc-400 hover:bg-zinc-900 hover:text-white"
      }`}
    >
      {t(page.labelKey)}
    </button>
  );

  return (
    <div className="min-h-screen md:flex">
      {/* mobile top bar */}
      <div className="sticky top-0 z-30 flex items-center justify-between border-b border-zinc-800 px-4 py-3 md:hidden">
        <div className="text-base font-bold">
          ⚡ LLMSwitch <span className="text-xs font-normal text-zinc-500">{t("common.aiGateway")}</span>
        </div>
        <div className="flex items-center gap-1">
          <LanguageToggle />
          <ThemeToggle />
          <button
            onClick={() => setMobileNav(true)}
            className="rounded-lg px-2 py-1.5 text-lg leading-none text-zinc-300 hover:text-white"
            aria-label="Menu"
          >
            ☰
          </button>
        </div>
      </div>

      {/* mobile backdrop */}
      {mobileNav && (
        <div className="fixed inset-0 z-40 bg-black/60 md:hidden" onClick={() => setMobileNav(false)} />
      )}

      {/* sidebar */}
      <aside
        className={`fixed inset-y-0 left-0 z-50 flex w-64 shrink-0 transform flex-col border-r border-zinc-800 bg-zinc-950 transition-transform duration-200 md:sticky md:top-0 md:z-auto md:h-screen md:translate-x-0 ${
          mobileNav ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="flex items-center justify-between px-4 py-4">
          <div className="text-lg font-bold">
            ⚡ LLMSwitch
            <div className="text-xs font-normal text-zinc-500">{t("common.aiGateway")}</div>
          </div>
          <button
            onClick={() => setMobileNav(false)}
            className="rounded-lg px-2 py-1 text-zinc-400 hover:text-white md:hidden"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto px-3 pb-4">
          <div className="flex flex-col gap-0.5">{PRIMARY.map(navItem)}</div>

          <div className="mt-5 border-t border-zinc-800/70 pt-3">
            <p className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
              {t("nav.advanced")}
            </p>
            {ADVANCED_SECTIONS.map((sec) => (
              <div key={sec.id} className="mb-1">
                <button
                  onClick={() => toggle(sec.id)}
                  className="flex w-full items-center justify-between rounded-lg px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-zinc-500 hover:text-zinc-300"
                >
                  <span>{t(sec.labelKey)}</span>
                  <span>{open[sec.id] ? "▾" : "▸"}</span>
                </button>
                {open[sec.id] && <div className="flex flex-col gap-0.5">{sec.pages.map(navItem)}</div>}
              </div>
            ))}
          </div>
        </nav>

        <div className="border-t border-zinc-800 px-4 py-3">
          <div className="mb-2 hidden items-center gap-1 md:flex">
            <LanguageToggle />
            <ThemeToggle />
          </div>
          {getSession() && (
            <button
              onClick={async () => {
                await authApi.logout().catch(() => undefined);
                setSession("");
                setAuthed(false);
              }}
              className="mb-3 w-full rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800"
            >
              {t("nav.logout")}
            </button>
          )}
        </div>
      </aside>
      <main key={adminKey} className="mx-auto w-full min-w-0 max-w-6xl px-4 py-8">
        {tab === "home" && <Home />}
        {tab === "onboarding" && <Onboarding />}
        {tab === "analytics" && <Analytics />}
        {tab === "activity" && <Activity />}
        {tab === "providers" && <Providers />}
        {tab === "live" && <Live />}
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
        {tab === "routing" && <Routing />}
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
