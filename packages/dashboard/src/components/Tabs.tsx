export interface TabDef {
  id: string;
  label: string;
  /** shown with a lock note; clicking does nothing */
  disabled?: boolean;
  title?: string;
}

/**
 * Shared nested-tab bar (OmniRoute nested-route parity).
 * Dark-first styling consistent with the rest of the dashboard.
 */
export function Tabs({
  tabs,
  active,
  onChange,
}: {
  tabs: TabDef[];
  active: string;
  onChange: (id: string) => void;
}) {
  return (
    <div className="mb-6 flex flex-wrap gap-2 border-b border-zinc-800 pb-3">
      {tabs.map((t) => (
        <button
          key={t.id}
          disabled={t.disabled}
          title={t.title ?? (t.disabled ? "Not available — see note below" : undefined)}
          onClick={() => !t.disabled && onChange(t.id)}
          className={`rounded-lg border px-3.5 py-1.5 text-sm transition-colors ${
            t.disabled
              ? "cursor-not-allowed border-zinc-800 text-zinc-600"
              : active === t.id
                ? "border-sky-600 bg-sky-950 text-sky-200"
                : "border-zinc-700 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
          }`}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

/** Honest empty-state box for tabs whose backend doesn't exist yet. */
export function TabEmpty({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-6 text-sm text-zinc-400">
      {children}
    </div>
  );
}
