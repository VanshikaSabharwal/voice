"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  ChatIcon, SettingsIcon, WaveIcon, CloseIcon, PlusIcon,
  BookIcon, UsersIcon, ClipboardIcon, ChartIcon, LogoutIcon,
} from "./Icons";
import { useConfig } from "../lib/ConfigContext";
import { useConnection } from "../lib/ConnectionContext";
import { PRESETS, type SavedConfig } from "../lib/presets";
import { DEFAULT_CONFIG } from "../lib/types";
import { useSession } from "../lib/useSession";
import type { Role } from "../../lib/reading/types";

type NavItem = {
  href: string;
  label: string;
  Icon: (props: { className?: string }) => React.ReactElement;
};

/**
 * Navigation per role. This mirrors the rules in proxy.ts — it decides what is
 * worth showing, never what is permitted; the guards do that.
 */
const NAV_BY_ROLE: Record<Role, NavItem[]> = {
  admin: [
    { href: "/admin", label: "Overview", Icon: ChartIcon },
    { href: "/admin/books", label: "Books", Icon: BookIcon },
    { href: "/admin/assessments", label: "Assessments", Icon: ClipboardIcon },
    { href: "/admin/users", label: "Teachers & Students", Icon: UsersIcon },
    { href: "/playground", label: "Voice Playground", Icon: WaveIcon },
    { href: "/conversations", label: "Conversations", Icon: ChatIcon },
    { href: "/settings", label: "Settings", Icon: SettingsIcon },
  ],
  teacher: [
    { href: "/teacher", label: "Assign", Icon: ClipboardIcon },
    { href: "/teacher/results", label: "Results", Icon: ChartIcon },
  ],
  student: [{ href: "/student", label: "My Reading", Icon: BookIcon }],
};

/** Saved configurations, connection status, and the Test Connection action. */
function SidebarFooter({ onNavigate }: { onNavigate: () => void }) {
  const { cfg, setCfg, activeId, setActiveId } = useConfig();
  const { probes, probing, error, check } = useConnection();
  const router = useRouter();
  const [saved, setSaved] = useState<SavedConfig[]>(PRESETS);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/configs")
      .then((r) => (r.ok ? r.json() : { configs: PRESETS }))
      .then((d: { configs: SavedConfig[] }) => {
        if (!cancelled && Array.isArray(d.configs)) setSaved(d.configs);
      })
      .catch(() => {
        // Presets are already shown; a failed load changes nothing.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function load(entry: SavedConfig) {
    setCfg(entry.config);
    setActiveId(entry.id);
    onNavigate();
    router.push("/settings");
  }

  function newConfig() {
    setCfg({ ...DEFAULT_CONFIG, name: "New Configuration" });
    setActiveId(null);
    onNavigate();
    router.push("/settings");
  }

  // Derived from the last probe; before any probe we say so rather than
  // claiming everything is fine.
  const health = (() => {
    if (!probes) return { tone: "text-[var(--text-subtle)]", dot: "bg-[var(--text-subtle)]", label: "Not checked" };
    const values = Object.values(probes);
    if (values.some((p) => p.status === "invalid"))
      return { tone: "text-[var(--danger)]", dot: "bg-[var(--danger)]", label: "Credential error" };
    if (values.some((p) => p.status === "rate_limited" || p.status === "unreachable"))
      return { tone: "text-[var(--warning)]", dot: "bg-[var(--warning)]", label: "Degraded" };
    if (values.every((p) => p.status === "missing"))
      return { tone: "text-[var(--text-subtle)]", dot: "bg-[var(--text-subtle)]", label: "No keys configured" };
    return { tone: "text-[var(--success)]", dot: "bg-[var(--success)]", label: "All systems operational" };
  })();

  return (
    <div className="border-t border-[var(--border)] p-4">
      <p className="mb-2 text-[11px] font-medium text-[var(--text-subtle)]">
        Saved Configurations
      </p>
      <ul className="mb-3 max-h-40 space-y-0.5 overflow-y-auto">
        {saved.map((entry) => (
          <li key={entry.id}>
            <button
              onClick={() => load(entry)}
              className={`flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition
                ${activeId === entry.id
                  ? "bg-[var(--brand-soft)] font-medium text-[var(--brand)]"
                  : "text-[var(--text-muted)] hover:bg-[var(--surface-muted)]"
                }`}
            >
              <span className="truncate">{entry.name}</span>

              {/* A built-in and a saved config can share a name — the saved one
                  usually began as a copy of the preset. Without this badge the
                  two are indistinguishable, and edits appear not to save
                  because the read-only twin was the one selected. */}
              {entry.builtin && (
                <span className="shrink-0 rounded bg-[var(--surface-muted)] px-1 py-px text-[9px] text-[var(--text-subtle)]">
                  built-in
                </span>
              )}

              {activeId === entry.id && (
                <span className="ml-auto shrink-0 text-[10px]">Active</span>
              )}
            </button>
          </li>
        ))}
      </ul>

      {/* <button
        onClick={newConfig}
        className="mb-3 flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-[var(--border-strong)] px-3 py-1.5 text-[11px] font-medium text-[var(--text-muted)] transition hover:border-[var(--brand)] hover:text-[var(--brand)]"
      >
        <PlusIcon className="h-3.5 w-3.5" />
        New Configuration
      </button> */}

      <div className="rounded-lg bg-[var(--surface-muted)] p-3">
        <p className="text-[11px] font-medium text-[var(--text-subtle)]">
          Active Configuration
        </p>
        <p className="mt-1 truncate text-sm font-semibold">{cfg.name}</p>
        <p className={`mt-1.5 flex items-center gap-1.5 text-[11px] ${health.tone}`}>
          <span className={`h-1.5 w-1.5 rounded-full ${health.dot}`} />
          {health.label}
        </p>
      </div>

      <button
        onClick={() =>
          check(
            Array.from(
              new Set([cfg.stt.provider, cfg.llm.provider, cfg.tts.provider]),
            ),
          )
        }
        disabled={probing}
        className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg border border-[var(--border-strong)] px-3 py-2 text-xs font-medium text-[var(--text-muted)] transition hover:bg-[var(--surface-muted)] disabled:opacity-60"
      >
        <WaveIcon className="h-4 w-4" />
        {probing ? "Checking…" : "Test Connection"}
      </button>

      {error && (
        <p className="mt-2 text-[11px] text-[var(--danger)]">{error}</p>
      )}
    </div>
  );
}

export default function Sidebar({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const { session } = useSession();

  const nav = session ? NAV_BY_ROLE[session.role] : [];

  async function signOut() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.replace("/login");
    router.refresh();
  }

  return (
    <>
      {/* Scrim closes the drawer on mobile; inert on desktop where the rail is static. */}
      {open && (
        <div
          className="fixed inset-0 z-30 bg-black/40 lg:hidden"
          onClick={onClose}
          aria-hidden="true"
        />
      )}

      <aside
        className={`fixed inset-y-0 left-0 z-40 flex w-64 shrink-0 flex-col border-r border-[var(--border)]
                    bg-white transition-transform duration-200
                    lg:sticky lg:top-0 lg:h-screen lg:translate-x-0
                    ${open ? "translate-x-0" : "-translate-x-full"}`}
      >
        <div className="flex items-center justify-between px-5 py-5">
          <div className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-[var(--brand)] text-white">
              <WaveIcon className="h-5 w-5" />
            </span>
            <span className="leading-tight">
              <span className="block text-[15px] font-semibold">Reading</span>
              <span className="block text-[11px] capitalize text-[var(--text-subtle)]">
                {session ? session.role : "Assessment"}
              </span>
            </span>
          </div>
          <button
            onClick={onClose}
            className="text-[var(--text-muted)] lg:hidden"
            aria-label="Close menu"
          >
            <CloseIcon className="h-5 w-5" />
          </button>
        </div>

        <nav className="flex-1 space-y-1 overflow-y-auto px-3">
          {nav.map(({ href, label, Icon }) => {
            /* Exact match for section roots, prefix match for their children,
               so /admin/books highlights Books and not Overview. */
            const active =
              pathname === href ||
              (href !== "/" && pathname.startsWith(`${href}/`));

            return (
              <Link
                key={href}
                href={href}
                onClick={onClose}
                aria-current={active ? "page" : undefined}
                className={`flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition
                  ${active
                    ? "bg-[var(--brand-soft)] font-medium text-[var(--brand)]"
                    : "text-[var(--text-muted)] hover:bg-[var(--surface-muted)] hover:text-[var(--foreground)]"
                  }`}
              >
                <Icon className="h-[18px] w-[18px]" />
                {label}
              </Link>
            );
          })}
        </nav>

        {/* Voice-agent configuration is an operator concern, and the pages it
            links to are admin-only in proxy.ts. */}
        {session?.role === "admin" && <SidebarFooter onNavigate={onClose} />}

        {session && (
          <div className="border-t border-[var(--border)] p-4">
            <p className="truncate text-sm font-medium">{session.name}</p>
            <p className="truncate text-[11px] text-[var(--text-subtle)]">
              {session.email}
            </p>
            <button
              onClick={signOut}
              className="mt-3 flex w-full cursor-pointer items-center justify-center gap-2 rounded-lg border border-[var(--border-strong)] px-3 py-2 text-xs font-medium text-[var(--text-muted)] transition hover:bg-[var(--surface-muted)]"
            >
              <LogoutIcon className="h-4 w-4" />
              Sign out
            </button>
          </div>
        )}
      </aside>
    </>
  );
}
