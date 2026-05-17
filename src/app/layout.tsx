import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Tri-Rail Checkout Kit",
  description:
    "Drop-in Next.js checkout module with hot-swappable CardsShield + PsiFi + Quiklie rails. One env var picks which surface renders.",
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
