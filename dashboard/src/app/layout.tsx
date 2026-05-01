import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title:       "EchoForge Syndicate — Ruvon",
  description: "Sovereign browser quant mesh — PHIC dashboard",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="antialiased">{children}</body>
    </html>
  );
}
