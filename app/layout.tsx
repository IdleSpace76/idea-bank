import type { Metadata, Viewport } from "next";
import "./globals.css";
import { themeInitScript } from "@/lib/themes";
import { LanguageInit } from "@/components/language-picker";

export const metadata: Metadata = {
  title: "Idea Bank — a place for your ideas",
  description: "A personal library of ideas, thoughts and future discoveries.",
};

export const viewport: Viewport = { themeColor: "#faf9f6" };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en" suppressHydrationWarning><head><script dangerouslySetInnerHTML={{ __html: themeInitScript }} /></head><body><LanguageInit />{children}</body></html>;
}
