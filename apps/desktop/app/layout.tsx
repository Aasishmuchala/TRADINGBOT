import type { Metadata } from "next";
import "./globals.css";
import { cn } from "@/lib/utils";

const fontVars = { variable: "--font-sans" };
const monoVars = { variable: "--font-mono" };

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
    <html suppressHydrationWarning lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@300;400;500;600;700;800&family=JetBrains+Mono:wght@300;400;500;600&display=swap" rel="stylesheet" />
      </head>
      <body>
        <script dangerouslySetInnerHTML={{ __html: themeBootstrapScript }} />
        {children}
      </body>
    </html>
  );
}
