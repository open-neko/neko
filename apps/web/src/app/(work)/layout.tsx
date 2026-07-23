"use client";

import { usePathname } from "next/navigation";
import WorkContextRail from "./work/WorkContextRail";
import { WorkShellProvider } from "./work-shell-context";

export default function WorkShellLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // The context rail belongs only to Ask thread pages, not the
  // other surfaces (workflows/skills/memory) that share this shell.
  const pathname = usePathname();
  const showRail = pathname === "/work" || pathname?.startsWith("/work/");
  const isWorkflows =
    pathname === "/workflows" || pathname?.startsWith("/workflows/");

  return (
    <WorkShellProvider>
      <div
        className={`root operations-root${showRail ? " is-work" : ""}${
          isWorkflows ? " is-workflows" : ""
        }`}
      >
        <div className={`work-layout operations-layout${showRail ? " has-rail" : ""}`}>
          <main className="operations-main">{children}</main>
          {showRail && <WorkContextRail />}
        </div>
      </div>
    </WorkShellProvider>
  );
}
