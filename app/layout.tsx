import type { Metadata, Viewport } from "next";
import "./globals.css";
import TestModeBanner from "./test-mode-banner";

export const metadata: Metadata = {
  title: "Gestionale di Marinelli Stefano",
  description: "Cassa, clienti e magazzino per Viterbo e Gran Sasso.",
  manifest: "/manifest.webmanifest",
  applicationName: "Gestionale Stefano Marinelli",
  appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: "Gestionale SM" },
  other: {
    "codex-preview": "development",
  },
  icons: {
    icon: "/pwa-icon-192.png",
    shortcut: "/pwa-icon-192.png",
    apple: "/apple-touch-icon.png",
  },
};

export const viewport: Viewport = {
  themeColor: "#05090c",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="it">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Manrope:wght@400..800&display=swap" />
        {/* Material Symbols è self-hosted (public/fonts) via @font-face in globals.css: icone garantite anche offline. */}
      </head>
      <body className="antialiased">
        <TestModeBanner />
        {children}
      </body>
    </html>
  );
}
