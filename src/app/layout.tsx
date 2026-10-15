import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "StonedEditor",
  description: "AI code editor powered by OpenRouter",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="de">
      <body>{children}</body>
    </html>
  );
}

