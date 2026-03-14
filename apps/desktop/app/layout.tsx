import type { Metadata } from "next";
import "./globals.css";
import { cn } from "@/lib/utils";

// Fonts served via <link> in <head> — no build-time fetch
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
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link href="https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,400;0,9..40,500;0,9..40,600;0,9..40,700;1,9..40,400&family=Geist+Mono:wght@300;400;500;600&display=swap" rel="stylesheet" />
      </head>
      <body>
        <script dangerouslySetInnerHTML={{ __html: themeBootstrapScript }} />
        {children}
      </body>
    </html>
  );
}
