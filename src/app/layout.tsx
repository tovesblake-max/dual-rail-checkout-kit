import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Dual-Rail Checkout Kit",
  description:
    "Drop-in Next.js checkout module with hot-swappable PsiFi + CardsShield/KingsGate rails. One env var picks which iframe renders.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
