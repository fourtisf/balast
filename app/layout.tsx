import type { Metadata, Viewport } from 'next';
import { DM_Sans, IBM_Plex_Mono, Instrument_Serif } from 'next/font/google';
import { MarketProvider } from '@/components/providers/MarketProvider';
import { UiProvider } from '@/components/providers/UiProvider';
import { Footer } from '@/components/shell/Footer';
import { StakeDrawer } from '@/components/shell/StakeDrawer';
import { TopNav } from '@/components/shell/TopNav';
import { WalletModal } from '@/components/shell/WalletModal';
import { Toast } from '@/components/ui/Toast';
import { SITE_URL } from '@/lib/site';
import './globals.css';

// Three faces, each with one job (§19): the serif for headlines, the sans
// for everything read, the mono for everything counted.
const serif = Instrument_Serif({
  subsets: ['latin'],
  weight: '400',
  style: ['normal', 'italic'],
  variable: '--font-instrument-serif',
  display: 'swap',
});

const sans = DM_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-dm-sans',
  display: 'swap',
});

const mono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-plex-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: 'Balast — Liquidity layer for Robinhood Chain',
  description:
    'Deposit into any token on Robinhood Chain and collect swap fees in WETH. No lockups, no emissions.',
  alternates: { canonical: '/' },
  openGraph: {
    type: 'website',
    url: SITE_URL,
    siteName: 'Balast',
    title: 'Balast — Liquidity layer for Robinhood Chain',
    description:
      'Deposit into any token on Robinhood Chain and collect swap fees in WETH. No lockups, no emissions.',
    images: [{ url: '/og-card.png', width: 1200, height: 630, alt: 'Balast' }],
  },
  twitter: { card: 'summary_large_image', images: ['/og-card.png'] },
};

export const viewport: Viewport = {
  themeColor: '#F5F3EE',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${serif.variable} ${sans.variable} ${mono.variable}`}>
      <body>
        <UiProvider>
          <MarketProvider>
            <a className="skip" href="#main">
              Skip to content
            </a>
            <TopNav />
            <main className="wrap" id="main">
              {children}
              <Footer />
            </main>
            <StakeDrawer />
            <WalletModal />
            <Toast />
          </MarketProvider>
        </UiProvider>
      </body>
    </html>
  );
}
