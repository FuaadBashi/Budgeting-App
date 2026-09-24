"use client";

import { useState, type KeyboardEvent, type PointerEvent } from "react";

/**
 * Picking a point on a chart by mouse, finger or keyboard.
 *
 * The charts listened only for mouseenter, and their captions said "Hover…".
 * A phone has no hover, so the readout under every chart -- on the calendar, the
 * only place a day's balance and events are shown -- could not be reached at
 * all. And a 90-day curve on a phone gives each day a ~4px strip, too thin to
 * tap one at a time.
 *
 * So selection is resolved from the pointer's position across the whole chart,
 * not from which strip it entered: one handler for mouse, touch and pen, and a
 * finger can drag across to scrub. A touch keeps its selection when the finger
 * lifts; a mouse clears it on leaving, as hover did. Arrow keys step through the
 * points for anyone not using a pointer.
 */
export function useChartSelection(count: number) {
  const [picked, setPicked] = useState<number | null>(null);
  // The data can shrink under a selection (a new scenario, a shorter month).
  const index = picked !== null && picked < count ? picked : null;

  /**
   * Props for the chart's <svg>. `indexAt` maps an x position in viewBox units
   * to a point index; it is clamped here, so it may return anything.
   */
  function svgProps(viewBoxWidth: number, indexAt: (x: number) => number, label: string) {
    const clamp = (i: number) => Math.max(0, Math.min(count - 1, Math.round(i)));

    function pick(event: PointerEvent<SVGSVGElement>) {
      const box = event.currentTarget.getBoundingClientRect();
      if (box.width === 0) return;
      setPicked(clamp(indexAt(((event.clientX - box.left) / box.width) * viewBoxWidth)));
    }

    function onKeyDown(event: KeyboardEvent<SVGSVGElement>) {
      const from = index ?? -1;
      const to =
        event.key === "ArrowRight" ? from + 1
        : event.key === "ArrowLeft" ? (index === null ? count - 1 : from - 1)
        : event.key === "Home" ? 0
        : event.key === "End" ? count - 1
        : event.key === "Escape" ? null
        : undefined;
      if (to === undefined) return;
      event.preventDefault();
      setPicked(to === null ? null : clamp(to));
    }

    return {
      // A focusable group rather than an image: it responds to keys, and the
      // readout below it is an aria-live region that announces each step.
      role: "group",
      "aria-roledescription": "chart",
      "aria-label": `${label}. Use the arrow keys to step through it.`,
      tabIndex: 0,
      onPointerDown: pick,
      onPointerMove: (event: PointerEvent<SVGSVGElement>) => {
        // A mouse tracks without a button, as hover did; a finger only while
        // it is down, so a flick past the chart is not a selection.
        if (event.pointerType === "mouse" || event.buttons) pick(event);
      },
      onPointerLeave: (event: PointerEvent<SVGSVGElement>) => {
        if (event.pointerType === "mouse") setPicked(null);
      },
      onKeyDown,
      // Vertical drags still scroll the page; horizontal ones scrub the chart.
      style: { touchAction: "pan-y" as const },
      className: "w-full rounded-[var(--radius-sm)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]",
    };
  }

  return { index, svgProps };
}

/** The readout prompt, identical in every chart so none of them says "Hover". */
export const PICK_PROMPT = "Tap, point at or use the arrow keys on the chart";
