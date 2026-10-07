import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { DesignProvider } from "@/lib/design";
import { designFontVariables } from "@/lib/fonts";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

/**
 * `viewport-fit=cover` so the app reaches under the notch when installed, and
 * `maximumScale` is deliberately left alone — capping zoom on a screen full of
 * small numbers is an accessibility failure, not a polish detail.
 */
export const viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f2ede1" },
    { media: "(prefers-color-scheme: dark)", color: "#0d0c0a" },
  ],
  viewportFit: "cover" as const,
};

export const metadata: Metadata = {
  title: "Personal Finance OS",
  description: "Ledger-first personal finance tracking, planning and simulation",
};

//: The design/appearance a returning visitor last chose is applied by
//: `DesignProvider` itself, via `useLayoutEffect` -- see `lib/design.tsx` for
//: why that lives there and not in a blocking boot script here.
//:
//: `<html>` is served carrying the defaults (DEFAULT_DESIGN, DEFAULT_APPEARANCE
//: in that file), which paint exactly as the bare :root fallback does. Without
//: them every motion rule, being scoped to a design, started matching only
//: once that effect ran after hydration: the page painted whole, then jumped
//: back to hidden to play its entrance. With them a default visitor's
//: entrance starts at first paint. The effect still corrects a stored choice.
export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      data-design="noir"
      data-theme="dark"
      className={`${geistSans.variable} ${geistMono.variable} ${designFontVariables} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <DesignProvider>{children}</DesignProvider>
      </body>
    </html>
  );
}
