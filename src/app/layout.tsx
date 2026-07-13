import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "StonedEditor",
  description: "AI code editor powered by FreeModel.dev",
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

