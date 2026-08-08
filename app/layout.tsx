import type { Metadata, Viewport } from "next";
import "./globals.css";

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
    <html lang="en">
      <body className="min-h-screen bg-neutral-950 text-neutral-100 antialiased">
        {children}
      </body>
    </html>
  );
}
