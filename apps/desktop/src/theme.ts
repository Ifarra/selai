import { useEffect, useState } from 'react';
import { CATPPUCCIN, type CatppuccinPalette, type CatppuccinTheme } from './catppuccin';

export type Theme = 'dark' | 'light' | 'system' | CatppuccinTheme;
export type ResolvedTheme = Exclude<Theme, 'system'>;
export const THEME_KEY = 'selai.theme';
export const THEME_OPTIONS: { value: Theme; label: string }[] = [
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' },
  { value: 'system', label: 'System' },
  { value: 'catppuccin-latte', label: 'Catppuccin Latte' },
  { value: 'catppuccin-frappe', label: 'Catppuccin Frappé' },
  { value: 'catppuccin-macchiato', label: 'Catppuccin Macchiato' },
  { value: 'catppuccin-mocha', label: 'Catppuccin Mocha' },
];

export const GLASS_KEY = 'selai.glass';
export const GLASS_BLUR_KEY = 'selai.glassBlur';
export const GLASS_OPACITY_KEY = 'selai.glassOpacity';
export const BG_IMAGE_KEY = 'selai.bgImage';
export const BG_BLUR_KEY = 'selai.bgBlur';
export const BG_DIM_KEY = 'selai.bgDim';
export const BG_FIT_KEY = 'selai.bgFit';
export const TERMINAL_SURFACE_KEY = 'selai.terminalSurface';
export const TERMINAL_OPACITY_KEY = 'selai.terminalOpacity';

export type BackgroundFit = 'cover' | 'contain' | 'tile';
export type TerminalSurface = 'opaque' | 'translucent' | 'glass';

export interface AppearancePreferences {
  glass: boolean;
  /** Backdrop blur behind glass surfaces, in pixels. */
  glassBlur: number;
  /** How much of each surface colour remains over the image, as a percentage. */
  glassOpacity: number;
  /** A data URL for the chosen image, or null for the plain theme background. */
  background: string | null;
  /** Blur applied to the image layer, in pixels. */
  backgroundBlur: number;
  /** Theme-colour wash over the image, as a percentage. Keeps text readable. */
  backgroundDim: number;
  backgroundFit: BackgroundFit;
  /** How the terminal background treats the image behind it. */
  terminalSurface: TerminalSurface;
  /** Terminal background colour strength, as a percentage. */
  terminalOpacity: number;
}

export const APPEARANCE_DEFAULTS: AppearancePreferences = {
  glass: false,
  glassBlur: 18,
  glassOpacity: 62,
  background: null,
  backgroundBlur: 0,
  backgroundDim: 35,
  backgroundFit: 'cover',
  terminalSurface: 'opaque',
  terminalOpacity: 92,
};

const APPEARANCE_KEYS = [
  GLASS_KEY, GLASS_BLUR_KEY, GLASS_OPACITY_KEY, BG_IMAGE_KEY, BG_BLUR_KEY, BG_DIM_KEY, BG_FIT_KEY,
  TERMINAL_SURFACE_KEY, TERMINAL_OPACITY_KEY,
];

function readStored(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

function readNumber(key: string, fallback: number, min: number, max: number): number {
  const raw = readStored(key);
  if (raw === null || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;
}

function isBackgroundFit(value: string | null): value is BackgroundFit {
  return value === 'cover' || value === 'contain' || value === 'tile';
}

function isTerminalSurface(value: string | null): value is TerminalSurface {
  return value === 'opaque' || value === 'translucent' || value === 'glass';
}

/** Display preferences are per device, so local storage is the right home. */
export function readAppearance(): AppearancePreferences {
  const background = readStored(BG_IMAGE_KEY);
  const fit = readStored(BG_FIT_KEY);
  const surface = readStored(TERMINAL_SURFACE_KEY);
  return {
    glass: readStored(GLASS_KEY) === '1',
    glassBlur: readNumber(GLASS_BLUR_KEY, APPEARANCE_DEFAULTS.glassBlur, 0, 40),
    glassOpacity: readNumber(GLASS_OPACITY_KEY, APPEARANCE_DEFAULTS.glassOpacity, 20, 92),
    // Only accept images this app wrote itself; remote URLs stay out of the shell.
    background: background?.startsWith('data:image/') ? background : null,
    backgroundBlur: readNumber(BG_BLUR_KEY, APPEARANCE_DEFAULTS.backgroundBlur, 0, 32),
    backgroundDim: readNumber(BG_DIM_KEY, APPEARANCE_DEFAULTS.backgroundDim, 0, 80),
    backgroundFit: isBackgroundFit(fit) ? fit : APPEARANCE_DEFAULTS.backgroundFit,
    terminalSurface: isTerminalSurface(surface) ? surface : APPEARANCE_DEFAULTS.terminalSurface,
    terminalOpacity: readNumber(TERMINAL_OPACITY_KEY, APPEARANCE_DEFAULTS.terminalOpacity, 20, 100),
  };
}

/** Persist one field so dragging a slider never rewrites a large image. */
export function writeAppearanceField<K extends keyof AppearancePreferences>(field: K, value: AppearancePreferences[K]): boolean {
  try {
    switch (field) {
      case 'glass': localStorage.setItem(GLASS_KEY, value ? '1' : '0'); break;
      case 'glassBlur': localStorage.setItem(GLASS_BLUR_KEY, String(value)); break;
      case 'glassOpacity': localStorage.setItem(GLASS_OPACITY_KEY, String(value)); break;
      case 'background':
        if (typeof value === 'string' && value) localStorage.setItem(BG_IMAGE_KEY, value);
        else localStorage.removeItem(BG_IMAGE_KEY);
        break;
      case 'backgroundBlur': localStorage.setItem(BG_BLUR_KEY, String(value)); break;
      case 'backgroundDim': localStorage.setItem(BG_DIM_KEY, String(value)); break;
      case 'backgroundFit': localStorage.setItem(BG_FIT_KEY, String(value)); break;
    }
    return true;
  } catch {
    return false;
  }
}

export function clearAppearancePreferences(): void {
  for (const key of APPEARANCE_KEYS) {
    try { localStorage.removeItem(key); } catch { /* Keep applying the defaults for this session. */ }
  }
}

export function applyAppearance(preferences: AppearancePreferences = readAppearance()): void {
  const root = document.documentElement;
  root.classList.toggle('glass', preferences.glass);
  root.classList.toggle('has-bg', Boolean(preferences.background));
  root.style.setProperty('--glass-blur', `${preferences.glassBlur}px`);
  root.style.setProperty('--glass-alpha', `${preferences.glassOpacity}%`);
  root.style.setProperty('--bg-blur', `${preferences.backgroundBlur}px`);
  root.style.setProperty('--bg-dim', `${preferences.backgroundDim}%`);
  root.style.setProperty('--bg-size', preferences.backgroundFit === 'tile' ? 'auto' : preferences.backgroundFit);
  root.style.setProperty('--bg-repeat', preferences.backgroundFit === 'tile' ? 'repeat' : 'no-repeat');
  if (preferences.background) {
    // JSON quoting produces a valid CSS string for the data URL.
    root.style.setProperty('--bg-image', `url(${JSON.stringify(preferences.background)})`);
  } else {
    root.style.removeProperty('--bg-image');
  }
}

export function readThemePreference(): Theme {
  try {
    const saved = window.localStorage.getItem(THEME_KEY);
    return THEME_OPTIONS.find((option) => option.value === saved)?.value ?? 'dark';
  } catch { return 'dark'; }
}

export function isLightTheme(theme: ResolvedTheme): boolean {
  return theme === 'light' || theme === 'catppuccin-latte';
}

function catppuccinVariables(p: CatppuccinPalette, light: boolean): Record<string, string> {
  return {
    '--bg': p.base, '--sidebar': p.mantle, '--surface': p.base,
    '--surface-2': p.mantle, '--surface-3': p.surface0,
    '--border': p.surface0, '--border-strong': p.surface1,
    '--fg': p.text, '--fg-strong': p.text, '--muted': p.subtext1, '--faint': p.subtext0,
    '--accent': p.mauve, '--accent-hover': `color-mix(in srgb, ${p.mauve} 85%, ${p.text})`,
    '--accent-soft': `${p.mauve}1a`, '--accent-fg': light ? p.base : p.crust,
    '--success': light ? `color-mix(in srgb, ${p.green} 55%, ${p.text})` : p.green,
    '--success-soft': `${p.green}1a`,
    '--warning': light ? `color-mix(in srgb, ${p.yellow} 45%, ${p.text})` : p.yellow,
    '--warning-soft': `${p.yellow}1a`, '--danger': p.red, '--danger-soft': `${p.red}1a`,
    '--term-bg': p.base, '--terminal-bg': p.base, '--terminal-fg': p.text,
    '--terminal-overlay': `${p.base}eb`,
    '--shadow': `0 16px 48px ${p.crust}${light ? '24' : '66'}`,
    'color-scheme': light ? 'light' : 'dark',
  };
}

const CUSTOM_THEME_PROPERTIES = Object.keys(catppuccinVariables(CATPPUCCIN['catppuccin-mocha'], false));

/** Also used before React mounts so the unlock screen uses the saved palette. */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === 'system') delete root.dataset.theme;
  else root.dataset.theme = theme;
  for (const name of CUSTOM_THEME_PROPERTIES) root.style.removeProperty(name);
  if (theme in CATPPUCCIN) {
    const variables = catppuccinVariables(CATPPUCCIN[theme as CatppuccinTheme], theme === 'catppuccin-latte');
    for (const [name, value] of Object.entries(variables)) root.style.setProperty(name, value);
  }
}

/** One system-theme subscription for the workbench, shared by all terminals. */
export function useResolvedTheme(theme: Theme): ResolvedTheme {
  const [systemLight, setSystemLight] = useState(() => window.matchMedia?.('(prefers-color-scheme: light)').matches ?? false);
  useEffect(() => {
    const media = window.matchMedia?.('(prefers-color-scheme: light)');
    if (!media) return;
    const changed = () => setSystemLight(media.matches);
    changed();
    media.addEventListener('change', changed);
    return () => media.removeEventListener('change', changed);
  }, []);
  return theme === 'system' ? (systemLight ? 'light' : 'dark') : theme;
}
