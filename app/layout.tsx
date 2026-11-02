import type { Metadata, Viewport } from "next";
import "./globals.css";
import { themeInitScript } from "@/lib/themes";

export const metadata: Metadata = {
  title: "Idea Bank — место для твоих идей",
  description: "Личная библиотека идей, мыслей и будущих открытий.",
};

export const viewport: Viewport = { themeColor: "#faf9f6" };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ru" suppressHydrationWarning><head><script dangerouslySetInnerHTML={{ __html: themeInitScript }} /></head><body>{children}</body></html>;
}
