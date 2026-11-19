import { BRAND_DOMAIN, BRAND_NAME, BRAND_TAGLINE } from "@rationale/config";
import type { Metadata, Viewport } from "next";
import { Bricolage_Grotesque, Instrument_Sans } from "next/font/google";
import type { ReactNode } from "react";
import "./globals.css";

const display = Bricolage_Grotesque({
  subsets: ["latin"],
  axes: ["opsz"],
  variable: "--font-display",
  display: "swap",
});

const body = Instrument_Sans({
  subsets: ["latin"],
  variable: "--font-body",
  display: "swap",
});

const title = `${BRAND_NAME}. Trading agents that show their reasoning`;
const description =
  "Describe a trading strategy in a sentence. Your agent reads the market every hour and writes down why it acted or waited. Paper trading is open.";

export const metadata: Metadata = {
  metadataBase: new URL(`https://${BRAND_DOMAIN}`),
  title,
  description,
  applicationName: BRAND_NAME,
  alternates: { canonical: "/" },
  openGraph: { type: "website", url: "/", siteName: BRAND_NAME, title, description: BRAND_TAGLINE, locale: "en_US" },
  twitter: { card: "summary_large_image", title, description: BRAND_TAGLINE },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#F3F1EC",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable}`}>
      <body>{children}</body>
    </html>
  );
}
