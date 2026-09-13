import type { Metadata, Viewport } from 'next';
import { Inter, JetBrains_Mono } from 'next/font/google';
import { MarketProvider } from '@/components/providers/MarketProvider';
import { UiProvider } from '@/components/providers/UiProvider';
import { Footer } from '@/components/shell/Footer';
import { Sidebar } from '@/components/shell/Sidebar';
import { StakeDrawer } from '@/components/shell/StakeDrawer';
import { TopBar } from '@/components/shell/TopBar';
import { Toast } from '@/components/ui/Toast';
import { SITE_URL } from '@/lib/site';
import './globals.css';

const mono = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-jetbrains-mono',
  display: 'swap',
});

// Inter is the fallback stack only (§5).
const sans = Inter({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-inter',
  display: 'swap',
});

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: 'Depth — Liquidity layer for Robinhood Chain',
  description:
    'Deposit into any token on Robinhood Chain and collect swap fees in WETH. No lockups, no emissions.',
  alternates: { canonical: '/' },
};

export const viewport: Viewport = {
  themeColor: '#050807',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${mono.variable} ${sans.variable}`}>
      <body>
        <UiProvider>
          <MarketProvider>
            <a className="skip" href="#main">
              Skip to content
            </a>
            <Sidebar />
            <TopBar />
            <main className="wrap" id="main">
              {children}
              <Footer />
            </main>
            <StakeDrawer />
            <Toast />
          </MarketProvider>
        </UiProvider>
      </body>
    </html>
  );
}
