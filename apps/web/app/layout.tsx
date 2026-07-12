import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "CORE Analytics",
  description: "Plataforma investigativa para extrações Cellebrite UFDR."
};

const themeInitScript = `
  (function () {
    try {
      var key = "core-theme";
      var stored = localStorage.getItem(key);
      var isDark = stored ? stored === "dark" : window.matchMedia("(prefers-color-scheme: dark)").matches;
      document.documentElement.classList.toggle("dark", isDark);
      document.documentElement.style.colorScheme = isDark ? "dark" : "light";
    } catch (error) {
      document.documentElement.classList.remove("dark");
      document.documentElement.style.colorScheme = "light";
    }
  })();
`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
