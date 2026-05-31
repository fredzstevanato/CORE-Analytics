import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "CORE Analytics",
  description: "Plataforma investigativa para extrações Cellebrite UFDR."
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  );
}
