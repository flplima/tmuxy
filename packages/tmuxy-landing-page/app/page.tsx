import { Header } from '@/components/Header';
import { Hero } from '@/components/Hero';
import { Features } from '@/components/Features';
import { OpenSource } from '@/components/OpenSource';
import { DownloadCTA } from '@/components/DownloadCTA';
import { Footer } from '@/components/Footer';

export default function Home() {
  return (
    <main className="min-h-screen">
      <Header />
      <Hero />
      <Features />
      <OpenSource />
      <DownloadCTA />
      <Footer />
    </main>
  );
}
