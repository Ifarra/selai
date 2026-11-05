import { useEffect, useRef, useState } from 'react';
import { backgroundImageFromFile } from '../appearanceImage';
import { describeError, preferencesGet, preferencesSet } from '../ipc';
import {
  APPEARANCE_DEFAULTS,
  applyAppearance,
  clearAppearancePreferences,
  readAppearance,
  writeAppearanceField,
  type AppearancePreferences,
  type BackgroundFit,
} from '../theme';
import { ThemedSelect } from '../ui/ThemedSelect';

const FIT_OPTIONS = [
  { value: 'cover', label: 'Fill the window' },
  { value: 'contain', label: 'Fit inside the window' },
  { value: 'tile', label: 'Tile the image' },
];

export function SettingsPage() {
  const [maxSteps, setMaxSteps] = useState(30);
  const [maxMinutes, setMaxMinutes] = useState(30);
  const [appearance, setAppearance] = useState<AppearancePreferences>(readAppearance);
  const appearanceRef = useRef(appearance);
  useEffect(() => { appearanceRef.current = appearance; }, [appearance]);
  const [imageBusy, setImageBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [appearanceError, setAppearanceError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    preferencesGet().then((prefs) => {
      if (!active) return;
      setMaxSteps(prefs.taskMaxSteps);
      setMaxMinutes(prefs.taskMaxMinutes);
    }).catch((err: unknown) => active && setError(describeError(err)));
    return () => { active = false; };
  }, []);

  function updateAppearance<K extends keyof AppearancePreferences>(field: K, value: AppearancePreferences[K]) {
    const next = { ...appearanceRef.current, [field]: value } as AppearancePreferences;
    appearanceRef.current = next;
    setAppearance(next);
    applyAppearance(next);
    setAppearanceError(writeAppearanceField(field, value)
      ? null
      : 'This appearance setting is too large to save on this device. It applies until Selai closes.');
  }

  async function onImageFile(file: File | null) {
    if (!file) return;
    setImageBusy(true);
    setAppearanceError(null);
    try {
      updateAppearance('background', await backgroundImageFromFile(file));
      setNotice('Background image updated.');
    } catch (err) {
      setAppearanceError(describeError(err));
    } finally {
      setImageBusy(false);
    }
  }

  function removeImage() {
    updateAppearance('background', null);
    setNotice('Background image removed.');
  }

  function resetAppearance() {
    clearAppearancePreferences();
    appearanceRef.current = { ...APPEARANCE_DEFAULTS };
    setAppearance(appearanceRef.current);
    applyAppearance(APPEARANCE_DEFAULTS);
    setAppearanceError(null);
    setNotice('Appearance reset to defaults.');
  }

  async function saveLimits() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const prefs = await preferencesSet({ taskMaxSteps: maxSteps, taskMaxMinutes: maxMinutes });
      setMaxSteps(prefs.taskMaxSteps);
      setMaxMinutes(prefs.taskMaxMinutes);
      setNotice(`Task budget saved: ${prefs.taskMaxSteps} steps or ${prefs.taskMaxMinutes} minutes.`);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label="Settings" className="page settings-page">
      <header className="page-head">
        <div className="grow">
          <h1>Settings</h1>
          <p>Configure task budgets and vault security for this Selai workspace.</p>
        </div>
      </header>

      <section className="card" aria-labelledby="settings-task-budget">
        <h2 id="settings-task-budget">AI task budget</h2>
        <p className="muted">A task stops when it reaches either limit. Changes apply to tasks started after saving.</p>
        <div className="form-row">
          <label className="field">
            Maximum steps
            <input type="number" min={1} max={300} value={maxSteps} disabled={busy}
              onChange={(e) => setMaxSteps(Number(e.target.value))} />
          </label>
          <label className="field">
            Time limit (minutes)
            <input type="number" min={1} max={300} value={maxMinutes} disabled={busy}
              onChange={(e) => setMaxMinutes(Number(e.target.value))} />
          </label>
          <button type="button" className="btn" disabled={busy} onClick={() => void saveLimits()}>
            {busy ? 'Saving…' : 'Save task budget'}
          </button>
        </div>
      </section>

      <section className="card" aria-labelledby="settings-security">
        <h2 id="settings-security">Security</h2>
        <p className="muted">Manage vault auto-lock, passphrase, recovery key, and encrypted backups.</p>
        <button type="button" className="btn" onClick={() => window.dispatchEvent(new Event('selai:security'))}>
          Open vault security
        </button>
      </section>

      <section className="card" aria-labelledby="settings-appearance">
        <h2 id="settings-appearance">Appearance</h2>
        <p className="muted">
          Put your own image behind the workbench and let panels blur what is behind them.
          These display preferences stay on this device.
        </p>

        <div className="appearance-controls">
          <label className="appearance-toggle">
            <input type="checkbox" checked={appearance.glass}
              onChange={(e) => updateAppearance('glass', e.target.checked)} />
            <span>
              <strong>Glassmorphism</strong>
              <small>Frosted panels with a blurred backdrop. Works best over a background image.</small>
            </span>
          </label>

          <div className="field-grid appearance-sliders">
            <label className="field">
              <span className="appearance-field-label">Glass blur <span className="appearance-value">{appearance.glassBlur}px</span></span>
              <input type="range" min={0} max={40} step={1} value={appearance.glassBlur}
                disabled={!appearance.glass}
                onChange={(e) => updateAppearance('glassBlur', Number(e.target.value))} />
            </label>
            <label className="field">
              <span className="appearance-field-label">Glass tint <span className="appearance-value">{appearance.glassOpacity}%</span></span>
              <input type="range" min={20} max={92} step={1} value={appearance.glassOpacity}
                disabled={!appearance.glass}
                onChange={(e) => updateAppearance('glassOpacity', Number(e.target.value))} />
            </label>
          </div>

          <div className="field">
            <label htmlFor="appearance-image">Background image</label>
            <div className="appearance-file-row">
              <input id="appearance-image" type="file" disabled={imageBusy}
                accept="image/png,image/jpeg,image/webp,image/gif,image/avif,image/bmp"
                onChange={(e) => {
                  const file = e.target.files?.[0] ?? null;
                  e.target.value = '';
                  void onImageFile(file);
                }} />
              {appearance.background && (
                <button type="button" className="btn" disabled={imageBusy} onClick={removeImage}>
                  Remove
                </button>
              )}
            </div>
            <span className="hint">
              {imageBusy ? 'Preparing image…' : 'PNG, JPEG, WebP, or GIF. Large images are resized before they are saved.'}
            </span>
          </div>

          {appearance.background && (
            <div className="appearance-thumb-row">
              <img className="appearance-thumb" src={appearance.background} alt="Background preview" />
              <p className="appearance-thumb-note">
                The image sits behind the workbench. Lower the dim for a brighter picture, or add blur
                when fine detail competes with the interface.
              </p>
            </div>
          )}

          <div className="field-grid appearance-sliders">
            <label className="field">
              <span className="appearance-field-label">Image blur <span className="appearance-value">{appearance.backgroundBlur}px</span></span>
              <input type="range" min={0} max={32} step={1} value={appearance.backgroundBlur}
                disabled={!appearance.background}
                onChange={(e) => updateAppearance('backgroundBlur', Number(e.target.value))} />
            </label>
            <label className="field">
              <span className="appearance-field-label">Image dim <span className="appearance-value">{appearance.backgroundDim}%</span></span>
              <input type="range" min={0} max={80} step={1} value={appearance.backgroundDim}
                disabled={!appearance.background}
                onChange={(e) => updateAppearance('backgroundDim', Number(e.target.value))} />
            </label>
          </div>

          <div className="field appearance-fit">
            <span>Image fit</span>
            <ThemedSelect label="Background image fit" value={appearance.backgroundFit} options={FIT_OPTIONS}
              disabled={!appearance.background}
              onChange={(value) => updateAppearance('backgroundFit', value as BackgroundFit)} />
          </div>

          <div className="appearance-actions">
            <button type="button" className="btn" onClick={resetAppearance}>Reset appearance</button>
          </div>
        </div>

        {appearanceError && <p className="banner" role="alert" data-tone="danger">{appearanceError}</p>}
      </section>

      {error && <p className="banner" role="alert" data-tone="danger">{error}</p>}
      {notice && <p className="banner" role="status" data-tone="success">{notice}</p>}
    </section>
  );
}
