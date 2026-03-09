type GtagEvent =
  | { name: 'demo_interact' }
  | { name: 'demo_tab_switch'; params: { tab_name: string } }
  | { name: 'demo_pane_group_click' }
  | { name: 'github_click' }
  | { name: 'share_click' }
  | { name: 'deepwiki_click' };

export function trackEvent(event: GtagEvent) {
  const gtag = (window as unknown as { gtag?: (...args: unknown[]) => void }).gtag;
  if (!gtag) return;
  if ('params' in event) {
    gtag('event', event.name, event.params);
  } else {
    gtag('event', event.name);
  }
}
