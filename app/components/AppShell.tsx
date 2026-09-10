"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";
import Sidebar from "./Sidebar";
import { MenuIcon, WaveIcon } from "./Icons";
import { ConfigProvider } from "../lib/ConfigContext";
import { ConnectionProvider } from "../lib/ConnectionContext";

/** Routes rendered without the application chrome. */
const BARE_ROUTES = ["/login"];

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  // The sign-in page stands alone: no navigation, and no config/connection
  // providers, which would fetch agent state for a user who is not signed in.
  if (BARE_ROUTES.includes(pathname)) return <>{children}</>;

  return (
    <ConfigProvider>
      <ConnectionProvider>
        <Shell>{children}</Shell>
      </ConnectionProvider>
    </ConfigProvider>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  const [navOpen, setNavOpen] = useState(false);

  return (
    <div className="flex min-h-screen">
      <Sidebar open={navOpen} onClose={() => setNavOpen(false)} />

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Mobile-only top bar: the sidebar brand lives in the drawer on small screens. */}
        <header className="flex items-center gap-3 border-b border-[var(--border)] bg-white px-4 py-3 lg:hidden">
          <button
            onClick={() => setNavOpen(true)}
            className="text-[var(--text-muted)]"
            aria-label="Open menu"
          >
            <MenuIcon className="h-6 w-6" />
          </button>
          <span className="flex items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-md bg-[var(--brand)] text-white">
              <WaveIcon className="h-4 w-4" />
            </span>
            <span className="text-sm font-semibold">Voice Agent</span>
          </span>
        </header>

        <main className="min-w-0 flex-1 overflow-x-hidden">{children}</main>
      </div>
    </div>
  );
}
