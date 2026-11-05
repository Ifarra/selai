import { act, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import {
  APPEARANCE_DEFAULTS,
  applyAppearance,
  applyTheme,
  BG_FIT_KEY,
  BG_IMAGE_KEY,
  GLASS_BLUR_KEY,
  GLASS_KEY,
  GLASS_OPACITY_KEY,
  readAppearance,
  readThemePreference,
  THEME_KEY,
  useResolvedTheme,
  writeAppearanceField,
  type Theme,
} from './theme';

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  applyTheme('dark');
  applyAppearance(APPEARANCE_DEFAULTS);
});

it('restores a saved Catppuccin theme and clears custom colors when returning to neutral themes', () => {
  localStorage.setItem(THEME_KEY, 'catppuccin-mocha');
  applyTheme(readThemePreference());
  expect(document.documentElement.dataset.theme).toBe('catppuccin-mocha');
  expect(document.documentElement.style.getPropertyValue('--terminal-bg')).toBe('#1e1e2e');
  expect(document.documentElement.style.getPropertyValue('--fg')).toBe('#cdd6f4');
  expect(document.documentElement.style.colorScheme).toBe('dark');
  applyTheme('catppuccin-latte');
  expect(document.documentElement.style.colorScheme).toBe('light');
  applyTheme('light');
  expect(document.documentElement.style.getPropertyValue('--terminal-bg')).toBe('');
  expect(document.documentElement.dataset.theme).toBe('light');
  applyTheme('system');
  expect(document.documentElement.dataset.theme).toBeUndefined();
  expect(document.documentElement.style.colorScheme).toBe('');
});

it('follows system changes only when System is selected and removes the listener', () => {
  let changed = () => {};
  const media = { matches: false, addEventListener: vi.fn((_name, callback) => { changed = callback; }), removeEventListener: vi.fn() };
  vi.stubGlobal('matchMedia', () => media);
  const { result, rerender, unmount } = renderHook(({ theme }: { theme: Theme }) => useResolvedTheme(theme), { initialProps: { theme: 'system' as Theme } });
  expect(result.current).toBe('dark');
  act(() => { media.matches = true; changed(); });
  expect(result.current).toBe('light');
  rerender({ theme: 'dark' });
  expect(result.current).toBe('dark');
  unmount();
  expect(media.removeEventListener).toHaveBeenCalledWith('change', changed);
});

it('restores glass and background appearance preferences', () => {
  writeAppearanceField('glass', true);
  writeAppearanceField('glassBlur', 24);
  writeAppearanceField('glassOpacity', 78);
  writeAppearanceField('background', 'data:image/png;base64,AAAA');
  writeAppearanceField('backgroundFit', 'tile');

  const saved = readAppearance();
  expect(saved).toMatchObject({
    glass: true,
    glassBlur: 24,
    glassOpacity: 78,
    background: 'data:image/png;base64,AAAA',
    backgroundFit: 'tile',
  });

  applyAppearance(saved);
  const root = document.documentElement;
  expect(root.classList.contains('glass')).toBe(true);
  expect(root.classList.contains('has-bg')).toBe(true);
  expect(root.style.getPropertyValue('--glass-blur')).toBe('24px');
  expect(root.style.getPropertyValue('--glass-alpha')).toBe('78%');
  expect(root.style.getPropertyValue('--bg-size')).toBe('auto');
  expect(root.style.getPropertyValue('--bg-repeat')).toBe('repeat');
  expect(root.style.getPropertyValue('--bg-image')).toContain('data:image/png;base64,AAAA');
});

it('clamps malformed appearance values and ignores remote image URLs', () => {
  localStorage.setItem(GLASS_KEY, '1');
  localStorage.setItem(GLASS_BLUR_KEY, '999');
  localStorage.setItem(GLASS_OPACITY_KEY, 'not-a-number');
  localStorage.setItem(BG_IMAGE_KEY, 'https://example.com/wallpaper.png');
  localStorage.setItem(BG_FIT_KEY, 'stretch');

  expect(readAppearance()).toMatchObject({
    glass: true,
    glassBlur: 40,
    glassOpacity: APPEARANCE_DEFAULTS.glassOpacity,
    background: null,
    backgroundFit: 'cover',
  });
});
