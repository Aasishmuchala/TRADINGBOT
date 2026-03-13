import type { Metadata } from "next";
import "./globals.css";
import { cn } from "@/lib/utils";

// Fonts injected via globals.css @import (works offline)
const spaceGrotesk = { variable: "--font-sans" };
const ibmPlexMono = { variable: "--font-mono" };

export const metadata: Metadata = {
  title: "NyraQ",
  description: "Local-only Binance operator console for NyraQ",
};

const themeBootstrapScript = `(() => {
  try {
    const preference = localStorage.getItem("sthyra-theme-preference") || "system";
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const resolved = preference === "dark" || (preference === "system" && prefersDark) ? "dark" : "light";
    const root = document.documentElement;
    root.dataset.theme = resolved;
    root.style.colorScheme = resolved;
    root.classList.toggle("dark", resolved === "dark");
  } catch {}
})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html suppressHydrationWarning lang="en" className={cn("font-sans", spaceGrotesk.variable, ibmPlexMono.variable)}>
      <body>
        <script dangerouslySetInnerHTML={{ __html: themeBootstrapScript }} />
        {children}
      </body>
    </html>
  );
}
