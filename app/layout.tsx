import type { Metadata, Viewport } from "next";
import "./globals.css";
import { ComingSoonProvider } from "./components/ComingSoon";

export const metadata: Metadata = {
  title: "Barkóba",
  description: "A mind duel: set a secret, or try to guess one.",
};

// This is played on a phone, not a desktop. Declared explicitly rather than
// relying on the framework default. maximumScale is deliberately NOT set:
// blocking pinch-zoom breaks accessibility for anyone who needs to zoom.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#0a0a0a",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="hu">
      {/*
        Parchment is now the product-wide ground: the front door paints its
        artwork stage over it, and every gameplay screen sits directly on it.
        The dark prototype background is gone as of 0.9.2.0.
      */}
      <body className="min-h-screen bg-[var(--parchment)] text-[var(--ink)] antialiased">
        <ComingSoonProvider>{children}</ComingSoonProvider>
      </body>
    </html>
  );
}
