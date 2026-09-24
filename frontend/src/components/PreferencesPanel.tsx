"use client";

import { useEffect, useRef, useState } from "react";
import {
  APPEARANCES,
  DESIGN_META,
  DESIGNS,
  useDesign,
  type Appearance,
} from "@/lib/design";

//: Four swatches per design, read off screen so this stays honest if a
//: palette ever moves -- picking colours by hand here would drift the moment
//: globals.css changed and nobody remembered to update this list too.
const SWATCH_VARS = ["--page-plane", "--surface-1", "--accent", "--text-primary"];

/**
 * The one control every one of the four designs has to share, since the
 * whole point is comparing them.
 *
 * Three placements. `floating` is a fixed desktop corner button for designs
 * whose chrome leaves that corner empty. `rail` sits inside an icon rail.
 * `header` keeps the mobile control in flow: a floating gear obscured calendar
 * details and rule actions as the page scrolled beneath it.
 */
export function PreferencesPanel({
  placement = "floating",
  className = "",
}: {
  placement?: "floating" | "rail" | "header";
  className?: string;
}) {
  const { design, setDesign, appearance, setAppearance } = useDesign();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const rail = placement === "rail";
  const header = placement === "header";

  return (
    <div
      ref={ref}
      className={`${rail || header ? "relative" : "fixed bottom-6 left-6 z-30"} ${className}`}
    >
      {open && (
        <div
          // In the rail the panel opens beside the rail rather than above the
          // button, and is `fixed` so the rail's own overflow cannot clip it.
          className={`w-72 rounded-[var(--radius)] p-4 ${
            rail
              ? "fixed bottom-6 left-20 z-40"
              : header
                ? "absolute right-0 top-full z-40 mt-3"
                : "mb-3"
          } ${design === "noir" ? "modal-in" : ""}`}
          style={{
            background: "var(--surface-1)",
            boxShadow: "inset 0 0 0 var(--border-w) var(--hairline), var(--shadow-raised)",
          }}
          role="dialog"
          aria-label="Appearance preferences"
        >
          <p className="section-label mb-3">Design</p>
          <div className="mb-4 grid grid-cols-2 gap-2">
            {DESIGNS.map((key) => (
              <DesignOption
                key={key}
                designKey={key}
                active={design === key}
                onSelect={() => setDesign(key)}
              />
            ))}
          </div>

          <p className="section-label mb-2">Appearance</p>
          <div
            className="flex gap-1 rounded-full p-1"
            style={{ background: "var(--surface-2)" }}
          >
            {APPEARANCES.map((a) => (
              <AppearanceOption
                key={a}
                value={a}
                active={appearance === a}
                onSelect={() => setAppearance(a)}
              />
            ))}
          </div>
        </div>
      )}

      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="Open appearance preferences"
        aria-expanded={open}
        className={
          rail
            ? "navlink flex h-10 w-10 items-center justify-center rounded-[var(--radius-sm)]"
            : "btn-shine flex h-11 w-11 items-center justify-center rounded-full"
        }
        style={
          rail
            ? { color: open ? "var(--accent-text)" : "var(--text-muted)" }
            : {
                background: "var(--surface-1)",
                color: "var(--text-secondary)",
                boxShadow: "inset 0 0 0 var(--border-w) var(--hairline), var(--shadow-raised)",
              }
        }
      >
        <IconGear />
      </button>
    </div>
  );
}

function DesignOption({
  designKey,
  active,
  onSelect,
}: {
  designKey: (typeof DESIGNS)[number];
  active: boolean;
  onSelect: () => void;
}) {
  const meta = DESIGN_META[designKey];
  return (
    <button
      type="button"
      onClick={onSelect}
      data-design={designKey}
      aria-pressed={active}
      className="rounded-[var(--radius-sm)] p-2.5 text-left"
      style={{
        boxShadow: active
          ? "0 0 0 2px var(--accent)"
          : "inset 0 0 0 var(--border-w) var(--hairline)",
      }}
    >
      {/* A swatch chip rendered IN that design's own tokens, not the panel's --
          scoping the data-design attribute here re-triggers the CSS cascade
          for just this element, so the preview needs no colour lookup table. */}
      <span className="mb-2 flex gap-1">
        {SWATCH_VARS.map((v) => (
          <span
            key={v}
            className="block h-3 w-3 rounded-sm"
            style={{ background: `var(${v})`, boxShadow: "inset 0 0 0 1px rgba(0,0,0,.12)" }}
          />
        ))}
      </span>
      <span className="block text-xs font-medium" style={{ color: "var(--text-primary)" }}>
        {meta.name}
      </span>
      <span className="block text-[10.5px] leading-tight" style={{ color: "var(--text-muted)" }}>
        {meta.thesis}
      </span>
    </button>
  );
}

const APPEARANCE_LABEL: Record<Appearance, string> = {
  system: "System",
  light: "Light",
  dark: "Dark",
};

function AppearanceOption({
  value,
  active,
  onSelect,
}: {
  value: Appearance;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={active}
      className="flex-1 rounded-full py-1.5 text-xs font-medium"
      style={{
        background: active ? "var(--accent)" : "transparent",
        color: active ? "var(--on-accent)" : "var(--text-secondary)",
      }}
    >
      {APPEARANCE_LABEL[value]}
    </button>
  );
}

function IconGear() {
  return (
    <svg width="19" height="19" viewBox="0 0 20 20" fill="none" aria-hidden>
      <path
        d="M10 12.7a2.7 2.7 0 1 0 0-5.4 2.7 2.7 0 0 0 0 5.4Z"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path
        d="M16.4 11.3a1.2 1.2 0 0 0 .24 1.32l.05.05a1.45 1.45 0 1 1-2.05 2.05l-.05-.05a1.2 1.2 0 0 0-1.32-.24 1.2 1.2 0 0 0-.73 1.1v.13a1.45 1.45 0 1 1-2.9 0v-.07a1.2 1.2 0 0 0-.78-1.1 1.2 1.2 0 0 0-1.32.24l-.05.05a1.45 1.45 0 1 1-2.05-2.05l.05-.05a1.2 1.2 0 0 0 .24-1.32 1.2 1.2 0 0 0-1.1-.73h-.13a1.45 1.45 0 1 1 0-2.9h.07a1.2 1.2 0 0 0 1.1-.78 1.2 1.2 0 0 0-.24-1.32l-.05-.05A1.45 1.45 0 1 1 6.5 3.4l.05.05a1.2 1.2 0 0 0 1.32.24H8a1.2 1.2 0 0 0 .73-1.1v-.13a1.45 1.45 0 1 1 2.9 0v.07a1.2 1.2 0 0 0 .73 1.1 1.2 1.2 0 0 0 1.32-.24l.05-.05a1.45 1.45 0 1 1 2.05 2.05l-.05.05a1.2 1.2 0 0 0-.24 1.32V7a1.2 1.2 0 0 0 1.1.73h.13a1.45 1.45 0 1 1 0 2.9h-.07a1.2 1.2 0 0 0-1.1.73Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  );
}
