import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title:       "EchoForge Syndicate — Ruvon",
  description: "Sovereign browser quant mesh — PHIC dashboard",
  icons: {
    icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><text y='26' font-size='26'>⚡</text></svg>",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="antialiased">{children}</body>
    </html>
  );
}
