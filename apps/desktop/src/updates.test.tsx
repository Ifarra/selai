import { StrictMode } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as ipc from './ipc';
import { UpdateButton, UpdateProvider, UpdateVersion } from './updates';

const available: ipc.UpdateCheck = {
  currentVersion: '0.3.1',
  update: {
    version: '0.3.2', notes: '## Improvements\n- Better terminal performance\n- Improved History',
    publishedAt: '2026-10-20T00:00:00Z', releaseUrl: 'https://github.com/f3ci/selai/releases/tag/v0.3.2',
    download: { name: 'Selai_0.3.2_x64-setup.exe', size: 12345678,
      url: 'https://github.com/f3ci/selai/releases/download/v0.3.2/Selai_0.3.2_x64-setup.exe' },
    inApp: false,
  },
};

function Shell() {
  return <UpdateProvider><header><UpdateButton /></header><UpdateVersion version="0.3.1" /><input aria-label="Work in progress" /></UpdateProvider>;
}

describe('Release updates', () => {
  beforeEach(() => {
    vi.spyOn(ipc, 'updateCheck').mockResolvedValue(available);
    vi.spyOn(ipc, 'updateOpen').mockResolvedValue();
  });
  afterEach(() => vi.restoreAllMocks());

  it('checks on launch once in StrictMode, quietly offers an update and leaves opening it to the user', async () => {
    render(<StrictMode><Shell /></StrictMode>);
    const button = await screen.findByRole('button', { name: 'Update available' });
    expect(ipc.updateCheck).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    button.focus();
    fireEvent.click(button);
    const dialog = screen.getByRole('dialog', { name: 'A new version is ready' });
    expect(within(dialog).getByText('0.3.1')).toBeInTheDocument();
    expect(within(dialog).getByText('0.3.2')).toBeInTheDocument();
    expect(await within(dialog).findByText('Better terminal performance', {}, { timeout: 5000 })).toBeInTheDocument();
    expect(ipc.updateOpen).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Later' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(button).toBeInTheDocument();
    expect(button).toHaveFocus();
    fireEvent.click(button);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(button).toHaveFocus();
  });

  it('opens the matching download only on click and explains how to install without closing work', async () => {
    render(<Shell />);
    fireEvent.change(screen.getByLabelText('Work in progress'), { target: { value: 'Unfinished task' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Update available' }));
    fireEvent.click(screen.getByRole('button', { name: 'Download update' }));
    expect(await screen.findByText('Download opened in your browser')).toBeInTheDocument();
    expect(ipc.updateOpen).toHaveBeenCalledWith('download');
    fireEvent.click(screen.getByRole('button', { name: 'Keep working' }));
    expect(screen.getByLabelText('Work in progress')).toHaveValue('Unfinished task');
    fireEvent.click(screen.getByRole('button', { name: 'Update available' }));
    fireEvent.click(screen.getByRole('button', { name: 'View on GitHub' }));
    await waitFor(() => expect(ipc.updateOpen).toHaveBeenCalledWith('release'));
  });

  it('stays quiet offline, retries on reconnection and supports manual retry', async () => {
    vi.mocked(ipc.updateCheck).mockRejectedValueOnce(new Error('Offline'));
    render(<Shell />);
    await waitFor(() => expect(ipc.updateCheck).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Update available' })).not.toBeInTheDocument();
    await act(async () => undefined);
    fireEvent(window, new Event('online'));
    fireEvent.click(await screen.findByRole('button', { name: 'Update available' }));
    expect(ipc.updateCheck).toHaveBeenCalledTimes(2);
  });

  it('reports manual check failures and can retry without showing a false up-to-date state', async () => {
    vi.mocked(ipc.updateCheck).mockRejectedValue(new Error('GitHub is limiting update checks'));
    render(<Shell />);
    await act(async () => undefined);
    fireEvent.click(screen.getByTitle('Check for updates'));
    expect(await screen.findByRole('alert')).toHaveTextContent('GitHub is limiting');
    expect(screen.queryByText(/running the latest/)).not.toBeInTheDocument();
    vi.mocked(ipc.updateCheck).mockResolvedValue({ currentVersion: '0.3.1', update: null });
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    expect(await screen.findByText(/running the latest available version/)).toBeInTheDocument();
  });

  it('shows browser launch errors and permits retrying the download', async () => {
    vi.mocked(ipc.updateOpen).mockRejectedValueOnce(new Error('No default browser'));
    render(<Shell />);
    fireEvent.click(await screen.findByRole('button', { name: 'Update available' }));
    fireEvent.click(screen.getByRole('button', { name: 'Download update' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('No default browser');
    expect(screen.queryByText('Download opened in your browser')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Download update' }));
    expect(await screen.findByText('Download opened in your browser')).toBeInTheDocument();
  });

  it('offers release details when this architecture has no installer, with safe local release notes', async () => {
    vi.mocked(ipc.updateCheck).mockResolvedValue({ ...available, update: { ...available.update!, download: null,
      notes: '[Read more](https://example.com) ![tracker](https://example.com/image.png) <script>alert(1)</script>' } });
    render(<Shell />);
    fireEvent.click(await screen.findByRole('button', { name: 'Update available' }));
    expect(screen.queryByRole('button', { name: 'Download update' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'View on GitHub' })).toBeInTheDocument();
    const notes = screen.getByRole('region', { name: 'Release notes' });
    await within(notes).findByText(/Read more/, {}, { timeout: 5000 });
    expect(notes.querySelectorAll('a,img,script')).toHaveLength(0);
  });

  describe('in-app updates', () => {
    const inApp: ipc.UpdateCheck = { ...available, update: { ...available.update!, inApp: true } };
    let emit: (event: ipc.UpdateDownloadEvent) => void = () => undefined;
    let finish: { resolve: () => void; reject: (err: unknown) => void };
    beforeEach(() => {
      vi.mocked(ipc.updateCheck).mockResolvedValue(inApp);
      vi.spyOn(ipc, 'updateDownload').mockImplementation((onEvent) => {
        emit = onEvent;
        return new Promise<void>((resolve, reject) => { finish = { resolve, reject }; });
      });
      vi.spyOn(ipc, 'updateCancel').mockResolvedValue();
      vi.spyOn(ipc, 'updateInstall').mockResolvedValue();
    });

    it('downloads only on click, keeps going while hidden and restarts only when asked', async () => {
      render(<Shell />);
      fireEvent.click(await screen.findByRole('button', { name: 'Update available' }));
      expect(ipc.updateDownload).not.toHaveBeenCalled();
      expect(screen.queryByRole('button', { name: 'Download update' })).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Update now' }));
      expect(ipc.updateDownload).toHaveBeenCalledTimes(1);
      act(() => { emit({ event: 'started', data: { total: 10 * 1048576 } }); });
      act(() => { emit({ event: 'progress', data: { downloaded: 4 * 1048576, total: 10 * 1048576 } }); });
      expect(screen.getByLabelText('Update download progress')).toHaveAttribute('value', '40');
      expect(screen.getByText('4.0 of 10.0 MB')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Hide' }));
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Downloading update 40%' })).toBeInTheDocument();
      await act(async () => { finish.resolve(); });
      const restartEntry = screen.getByRole('button', { name: 'Restart to update' });
      expect(ipc.updateInstall).not.toHaveBeenCalled();
      fireEvent.click(restartEntry);
      const dialog = screen.getByRole('dialog', { name: 'Ready to restart' });
      expect(within(dialog).getByText(/locks your vault/)).toBeInTheDocument();
      fireEvent.click(within(dialog).getByRole('button', { name: 'Restart now' }));
      await waitFor(() => expect(ipc.updateInstall).toHaveBeenCalledTimes(1));
    });

    it('can cancel a download and retry after a verification failure, with a manual fallback', async () => {
      render(<Shell />);
      fireEvent.click(await screen.findByRole('button', { name: 'Update available' }));
      fireEvent.click(screen.getByRole('button', { name: 'Update now' }));
      fireEvent.click(screen.getByRole('button', { name: 'Cancel download' }));
      expect(ipc.updateCancel).toHaveBeenCalledTimes(1);
      await act(async () => { finish.reject(new Error('The update failed its signature check and was discarded.')); });
      expect(screen.getByRole('alert')).toHaveTextContent('signature check');
      expect(screen.getByRole('button', { name: 'Download installer' })).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
      expect(ipc.updateDownload).toHaveBeenCalledTimes(2);
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('keeps the verified package when installation fails so the user can retry', async () => {
      vi.mocked(ipc.updateInstall).mockRejectedValueOnce(new Error('Installation was not authorized.'));
      render(<Shell />);
      fireEvent.click(await screen.findByRole('button', { name: 'Update available' }));
      fireEvent.click(screen.getByRole('button', { name: 'Update now' }));
      await act(async () => { finish.resolve(); });
      fireEvent.click(screen.getByRole('button', { name: 'Restart now' }));
      expect(await screen.findByRole('alert')).toHaveTextContent('not authorized');
      expect(ipc.updateDownload).toHaveBeenCalledTimes(1);
      fireEvent.click(screen.getByRole('button', { name: 'Restart now' }));
      await waitFor(() => expect(ipc.updateInstall).toHaveBeenCalledTimes(2));
    });
  });
});
