import { createContext, lazy, Suspense, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { describeError, updateCancel, updateCheck, updateDownload, updateInstall, updateOpen, type UpdateCheck } from './ipc';
import { CheckIcon, ImportIcon, LockIcon, RefreshIcon } from './ui/icons';
import { Dialog } from './ui/Overlay';
import './updates.css';

const ReleaseMarkdown = lazy(() => import('react-markdown'));

/** In-app package lifecycle. It lives in the provider, so a download keeps
 *  running while the dialog is closed. */
export type InstallState =
  | { phase: 'idle'; error?: string }
  | { phase: 'downloading'; downloaded: number; total: number | null }
  | { phase: 'ready'; error?: string }
  | { phase: 'installing' };

type Updates = {
  result: UpdateCheck | null;
  checking: boolean;
  error: string | null;
  install: InstallState;
  refresh: () => Promise<void>;
  show: () => void;
  download: () => Promise<void>;
  cancel: () => Promise<void>;
  restart: () => Promise<void>;
};
const UpdateContext = createContext<Updates | null>(null);

const MiB = 1048576;
const megabytes = (bytes: number) => (bytes / MiB).toFixed(1);

/** One check per launch, independent of vault and workspace lifetimes. */
export function UpdateProvider({ children }: { children: ReactNode }) {
  const [result, setResult] = useState<UpdateCheck | null>(null);
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [install, setInstall] = useState<InstallState>({ phase: 'idle' });
  const [open, setOpen] = useState(false);
  const inFlight = useRef<Promise<UpdateCheck> | null>(null);
  const mounted = useRef(false);
  const failed = useRef(false);

  const refresh = useCallback(async () => {
    setChecking(true);
    setError(null);
    const request = inFlight.current ??= updateCheck();
    try {
      const next = await request;
      if (mounted.current) {
        // A different release than the one already downloaded starts over.
        setResult((prev) => {
          if (prev?.update?.version !== next.update?.version) setInstall((s) => s.phase === 'ready' ? { phase: 'idle' } : s);
          return next;
        });
        failed.current = false;
      }
    } catch (err) {
      if (mounted.current) { setError(describeError(err)); failed.current = true; }
    } finally {
      if (inFlight.current === request) inFlight.current = null;
      if (mounted.current) setChecking(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const online = () => { if (failed.current) void refresh(); };
    window.addEventListener('online', online);
    return () => { mounted.current = false; window.removeEventListener('online', online); };
  }, [refresh]);

  const download = useCallback(async () => {
    setInstall({ phase: 'downloading', downloaded: 0, total: null });
    try {
      await updateDownload((event) => {
        if (!mounted.current) return;
        if (event.event === 'started') setInstall({ phase: 'downloading', downloaded: 0, total: event.data.total });
        else if (event.event === 'progress') setInstall({ phase: 'downloading', ...event.data });
      });
      if (mounted.current) setInstall({ phase: 'ready' });
    } catch (err) {
      if (mounted.current) setInstall({ phase: 'idle', error: describeError(err) });
    }
  }, []);

  const cancel = useCallback(async () => {
    try { await updateCancel(); } catch { /* the download reports its own outcome */ }
  }, []);

  const restart = useCallback(async () => {
    setInstall({ phase: 'installing' });
    try {
      await updateInstall();
      // Windows hands over to the installer and other platforms relaunch, so
      // this point is only reached if the process outlives the install.
    } catch (err) {
      // The backend keeps the verified package, so the user can retry.
      if (mounted.current) setInstall({ phase: 'ready', error: describeError(err) });
    }
  }, []);

  const value: Updates = { result, checking, error, install, refresh, show: () => setOpen(true), download, cancel, restart };
  return <UpdateContext.Provider value={value}>
    {children}
    {open && <UpdateDialog updates={value} close={() => setOpen(false)} />}
  </UpdateContext.Provider>;
}

function percent(install: InstallState) {
  return install.phase === 'downloading' && install.total ? Math.min(100, Math.floor(install.downloaded / install.total * 100)) : null;
}

/** Hidden until a newer version is known. Closing the dialog keeps this entry. */
export function UpdateButton() {
  const updates = useContext(UpdateContext);
  if (!updates?.result?.update) return null;
  const { install } = updates;
  const progress = percent(install);
  const label = install.phase === 'ready' ? 'Restart to update'
    : install.phase === 'installing' ? 'Installing update…'
      : install.phase === 'downloading' ? `Downloading update${progress === null ? '…' : ` ${progress}%`}`
        : 'Update available';
  return <button type="button" className="update-button" onClick={updates.show} data-phase={install.phase}
    title={`Selai ${updates.result.update.version} is available`}>
    {install.phase === 'downloading' || install.phase === 'installing' ? <span className="spinner" /> : <ImportIcon size={14} />}
    <span>{label}</span>
  </button>;
}

export function UpdateVersion({ version }: { version?: string }) {
  const updates = useContext(UpdateContext);
  if (!updates) return <span className="status-item">{version ? `Selai ${version}` : ''}</span>;
  return <button type="button" className="status-item update-version" title="Check for updates" onClick={() => {
    updates.show();
    // A check during a download or install would only repeat the offer.
    if (updates.install.phase === 'idle') void updates.refresh();
  }}>{version ? `Selai ${version}` : 'Updates'}</button>;
}

function UpdateDialog({ updates, close }: { updates: Updates; close: () => void }) {
  const [opening, setOpening] = useState(false);
  const [opened, setOpened] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  const update = updates.result?.update;
  const download = update?.download;
  const { install } = updates;
  const inApp = !!update?.inApp;

  async function openTarget(target: 'release' | 'download') {
    setOpening(true); setOpenError(null);
    try { await updateOpen(target); if (target === 'download') setOpened(true); }
    catch (err) { setOpenError(describeError(err)); }
    finally { setOpening(false); }
  }

  const busy = install.phase === 'downloading' || install.phase === 'installing';
  const title = install.phase === 'installing' ? 'Installing update'
    : install.phase === 'ready' ? 'Ready to restart'
      : update ? 'A new version is ready' : updates.checking ? 'Checking for updates' : updates.error ? 'Could not check for updates' : 'You’re up to date';

  const primary = inApp
    ? install.phase === 'ready'
      ? <button type="button" className="btn btn-primary" onClick={() => void updates.restart()}><RefreshIcon size={14} />Restart now</button>
      : install.phase === 'installing'
        ? <button type="button" className="btn btn-primary" disabled><span className="spinner" />Installing…</button>
        : install.phase === 'downloading'
          ? <button type="button" className="btn" onClick={() => void updates.cancel()}>Cancel download</button>
          : <button type="button" className="btn btn-primary" onClick={() => void updates.download()}>
            <ImportIcon size={14} />{install.error ? 'Try again' : 'Update now'}</button>
    : download ? <button type="button" className="btn btn-primary" disabled={opening} onClick={() => void openTarget('download')}>
      {opening ? <span className="spinner" /> : <ImportIcon size={14} />}{opening ? 'Opening…' : opened ? 'Download again' : 'Download update'}</button>
      : (!update || updates.error) && <button type="button" className="btn btn-primary" disabled={updates.checking} onClick={() => void updates.refresh()}>
        {updates.checking ? 'Checking…' : 'Check again'}</button>;

  return <Dialog className="update-dialog" eyebrow="SELAI UPDATES" closeLabel="Close updates" onClose={close}
    title={title}
    icon={update ? <ImportIcon size={19} /> : <RefreshIcon size={19} />}
    footer={<>
      {update && !busy && <button type="button" className="btn btn-ghost" disabled={opening} onClick={() => void openTarget('release')}>View on GitHub</button>}
      {inApp && (install.phase === 'idle' || install.phase === 'ready') && install.error && download &&
        <button type="button" className="btn btn-ghost" disabled={opening} onClick={() => void openTarget('download')}>Download installer</button>}
      <span className="grow" />
      {install.phase !== 'installing' && <button type="button" className="btn" onClick={close}>
        {opened ? 'Keep working' : install.phase === 'downloading' ? 'Hide' : update ? 'Later' : 'Close'}</button>}
      {primary}
    </>}>
      {update ? <>
        <div className="update-versions"><span>Installed <strong>{updates.result?.currentVersion}</strong></span>
          <span aria-hidden="true">→</span><span>Available <strong>{update.version}</strong></span></div>
        <section className="update-notes" aria-label="Release notes">
          <h3>What’s new{update.publishedAt && Number.isFinite(Date.parse(update.publishedAt))
            ? <time dateTime={update.publishedAt}>{new Date(update.publishedAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}</time> : null}</h3>
          {update.notes.trim() ? <Suspense fallback={<p>Loading release notes…</p>}>
            <ReleaseMarkdown skipHtml disallowedElements={['img', 'a']} unwrapDisallowed>{update.notes}</ReleaseMarkdown>
          </Suspense>
            : <p>Release notes are available on GitHub.</p>}
        </section>
        {inApp ? <InAppStatus install={install} />
          : <>
            {download ? <div className="update-installer"><ImportIcon size={16} /><div><strong>{download.name}</strong>
              <span>{megabytes(download.size)} MB · Download from GitHub</span></div></div>
              : <p>An installer for this device is not available yet. See the release on GitHub for download options.</p>}
            {opened ? <div role="status" className="update-next-step"><CheckIcon size={17} /><div><strong>Download opened in your browser</strong>
              <p>When the download finishes, save your work and close Selai, then run the installer to update.</p></div></div>
              : download && <p className="update-hint">Download the installer in your browser. When you’re ready, save your work and close Selai before installing.</p>}
          </>}
      </> : updates.checking ? <p role="status" className="history-loading"><span className="spinner" /> Looking for a newer release on GitHub…</p>
        : !updates.error && <p role="status">You’re running the latest available version{updates.result ? ` (${updates.result.currentVersion})` : ''}.</p>}
      {(updates.error || openError || ((install.phase === 'idle' || install.phase === 'ready') && install.error)) &&
        <p role="alert" className="banner" data-tone="danger">{openError || ((install.phase === 'idle' || install.phase === 'ready') && install.error) || updates.error}</p>}
  </Dialog>;
}

function InAppStatus({ install }: { install: InstallState }) {
  if (install.phase === 'downloading') {
    const progress = percent(install);
    return <div className="update-progress" role="status">
      <div className="update-progress-label"><span>Downloading and verifying…</span>
        <span>{megabytes(install.downloaded)}{install.total ? ` of ${megabytes(install.total)}` : ''} MB</span></div>
      <progress max={100} value={progress ?? undefined} aria-label="Update download progress" />
      <p className="update-hint">You can keep working. Selai will ask before restarting.</p>
    </div>;
  }
  if (install.phase === 'ready' || install.phase === 'installing') {
    return <>
      <div role="status" className="update-next-step"><CheckIcon size={17} /><div><strong>Update downloaded and verified</strong>
        <p>The package signature matches Selai’s release key.</p></div></div>
      <div className="update-warning"><LockIcon size={16} /><p>Restarting locks your vault and closes open terminals, file transfers and port
        forwards. Save your work before you continue.</p></div>
    </>;
  }
  return <p className="update-hint">Selai downloads the update, checks its signature, and asks before restarting. Nothing is installed until you choose <strong>Restart now</strong>.</p>;
}
