import { useLayoutEffect } from 'react';

/** Keep the app inside Safari's visible area without shrinking installed iOS apps. */
export function useViewportHeight() {
  useLayoutEffect(() => {
    const root = document.documentElement;
    const viewport = window.visualViewport;
    const standalone = window.matchMedia('(display-mode: standalone)');
    const fullscreen = window.matchMedia('(display-mode: fullscreen)');
    const iosNavigator = navigator as Navigator & { standalone?: boolean };
    const properties = ['--app-height', '--app-width', '--app-top', '--app-left', '--wind-bottom-inset'];
    const previousValues = properties.map(name => [name, root.style.getPropertyValue(name)]);
    const isIosWebKit = window.CSS?.supports('-webkit-touch-callout', 'none') ?? false;
    let frame = 0;

    const updateHeight = () => {
      frame = 0;
      const isApp = standalone.matches || fullscreen.matches ||
        iosNavigator.standalone === true || Boolean(document.fullscreenElement);

      // iOS standalone can report a shorter dynamic viewport below a translucent
      // status bar. The large viewport fills the installed app's full screen.
      if (isApp) {
        root.style.setProperty('--app-height', '100vh');
        root.style.setProperty('--app-width', '100%');
        root.style.setProperty('--app-top', '0px');
        root.style.setProperty('--app-left', '0px');
        root.style.removeProperty('--wind-bottom-inset');
      } else if (!viewport || Math.abs(viewport.scale - 1) < 0.01) {
        const height = viewport?.height ?? window.innerHeight;
        if (height > 0) {
          root.style.setProperty('--app-height', `${height}px`);
          root.style.setProperty('--app-width', `${viewport?.width ?? window.innerWidth}px`);
          root.style.setProperty('--app-top', `${viewport?.offsetTop ?? 0}px`);
          root.style.setProperty('--app-left', `${viewport?.offsetLeft ?? 0}px`);
        }
        if (isIosWebKit) root.style.setProperty('--wind-bottom-inset', '0px');
      }
    };

    const scheduleUpdate = () => {
      if (!frame) frame = window.requestAnimationFrame(updateHeight);
    };

    updateHeight();
    window.addEventListener('resize', scheduleUpdate);
    window.addEventListener('pageshow', scheduleUpdate);
    viewport?.addEventListener('resize', scheduleUpdate);
    viewport?.addEventListener('scroll', scheduleUpdate);
    document.addEventListener('fullscreenchange', scheduleUpdate);
    standalone.addEventListener('change', scheduleUpdate);
    fullscreen.addEventListener('change', scheduleUpdate);

    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('resize', scheduleUpdate);
      window.removeEventListener('pageshow', scheduleUpdate);
      viewport?.removeEventListener('resize', scheduleUpdate);
      viewport?.removeEventListener('scroll', scheduleUpdate);
      document.removeEventListener('fullscreenchange', scheduleUpdate);
      standalone.removeEventListener('change', scheduleUpdate);
      fullscreen.removeEventListener('change', scheduleUpdate);
      previousValues.forEach(([name, value]) => {
        if (value) root.style.setProperty(name, value);
        else root.style.removeProperty(name);
      });
    };
  }, []);
}
