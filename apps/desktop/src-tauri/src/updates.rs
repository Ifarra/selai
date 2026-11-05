//! Public release discovery works before vault unlock. Only URLs constructed
//! here for this repository can be opened; the webview never supplies a URL.
//!
//! In-app installation reuses the release chosen by discovery: the signed
//! updater manifest (`latest.json`) is read from that exact tag, so 0.x
//! prereleases stay eligible and `releases/latest` is never consulted. The
//! package is verified against the public key in `tauri.conf.json`, and the
//! signature must name the announced version (`requireSignedVersion`), before
//! it is kept for installation. Installation locks the vault first.
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use reqwest::{Client, Url};
use selai_domain::ErrorCode;
use semver::Version;
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::{AppHandle, State};
use tauri_plugin_updater::UpdaterExt;
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

use crate::dto::CommandError;
use crate::AppState;

const RELEASES_API: &str = "https://api.github.com/repos/f3ci/selai/releases?per_page=100";
const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
/// The updater manifest published next to the installers of each release.
const MANIFEST_ASSET: &str = "latest.json";
/// Installers are about 15 MiB; anything far larger is not a Selai package.
const MAX_PACKAGE_BYTES: u64 = 256 * 1024 * 1024;

#[derive(Default)]
pub struct UpdateService {
    cached: Mutex<Option<(Instant, UpdateCheck)>>,
    package: Mutex<Package>,
}

/// The in-app package lifecycle. Only one download runs at a time, and only a
/// verified package for the currently offered version can be installed.
#[derive(Default)]
enum Package {
    #[default]
    None,
    Downloading {
        cancel: CancellationToken,
    },
    Ready {
        update: Box<tauri_plugin_updater::Update>,
        bytes: Arc<Vec<u8>>,
    },
    Installing,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheck {
    current_version: String,
    update: Option<ReleaseUpdate>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReleaseUpdate {
    version: String,
    notes: String,
    published_at: Option<String>,
    release_url: String,
    download: Option<Download>,
    /// True when this installation can download, verify and install the
    /// release itself. Otherwise the UI falls back to a browser download.
    in_app: bool,
    #[serde(skip)]
    manifest_url: Option<String>,
}

/// Progress for one in-app download, streamed over a Tauri channel.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase", tag = "event", content = "data")]
pub enum DownloadEvent {
    Started { total: Option<u64> },
    Progress { downloaded: u64, total: Option<u64> },
    Verified,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Download {
    name: String,
    size: u64,
    url: String,
}

#[derive(Deserialize)]
struct Release {
    tag_name: String,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    prerelease: bool,
    body: Option<String>,
    published_at: Option<String>,
    #[serde(default)]
    assets: Vec<Asset>,
}

#[derive(Deserialize)]
struct Asset {
    name: String,
    size: u64,
    state: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum UpdateTarget {
    Release,
    Download,
}

fn error(message: &str) -> CommandError {
    CommandError::new(ErrorCode::Internal, message)
}

#[tauri::command]
pub async fn update_check(state: State<'_, UpdateService>) -> Result<UpdateCheck, CommandError> {
    // Deduplicate simultaneous checks and avoid repeated GitHub requests when
    // the UI remounts. Errors are never cached, so a manual retry can recover.
    let mut cached = state.cached.lock().await;
    if let Some((at, check)) = cached.as_ref() {
        if at.elapsed() < Duration::from_secs(60) {
            return Ok(check.clone());
        }
    }
    let client = Client::builder()
        .https_only(true)
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(15))
        .user_agent(concat!("Selai/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|_| error("Could not start the update check."))?;
    let releases = fetch_releases(&client, RELEASES_API).await?;
    let check = select_update(
        releases,
        env!("CARGO_PKG_VERSION"),
        std::env::consts::OS,
        std::env::consts::ARCH,
        in_app_supported(),
    )?;
    *cached = Some((Instant::now(), check.clone()));
    Ok(check)
}

async fn fetch_releases(client: &Client, endpoint: &str) -> Result<Vec<Release>, CommandError> {
    let mut response = client
        .get(endpoint)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .send()
        .await
        .map_err(|_| error("Could not reach GitHub. Check your connection and try again."))?;
    if response.status() == 403 || response.status() == 429 {
        return Err(error(
            "GitHub is limiting update checks. Please try again later.",
        ));
    }
    if !response.status().is_success() {
        return Err(error(
            "GitHub releases are unavailable. Please try again later.",
        ));
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| error("The update check was interrupted. Try again."))?
    {
        if body.len() + chunk.len() > MAX_RESPONSE_BYTES {
            return Err(error("The release response is too large."));
        }
        body.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&body).map_err(|_| error("GitHub returned an invalid release response."))
}

fn repository_url(segments: &[&str]) -> Result<String, CommandError> {
    let mut url = Url::parse("https://github.com/f3ci/selai/releases/")
        .map_err(|_| error("Invalid release address."))?;
    url.path_segments_mut()
        .map_err(|_| error("Invalid release address."))?
        .pop_if_empty()
        .extend(segments.iter().copied());
    Ok(url.into())
}

fn installer_names(version: &Version, os: &str, arch: &str) -> Vec<String> {
    let arch = match (os, arch) {
        ("windows", "x86_64") => "x64",
        ("windows", "aarch64") => "arm64",
        ("linux", "x86_64") => "amd64",
        ("linux" | "macos", "aarch64") => "aarch64",
        ("macos", "x86_64") => "x64",
        _ => return Vec::new(),
    };
    let prefix = format!("Selai_{version}_{arch}");
    match os {
        "windows" => vec![format!("{prefix}-setup.exe"), format!("{prefix}_en-US.msi")],
        "linux" => vec![format!("{prefix}.AppImage"), format!("{prefix}.deb")],
        "macos" => vec![format!("{prefix}.dmg")],
        _ => Vec::new(),
    }
}

/// The package formats the updater can replace in place. A `.deb` install is
/// owned by the system package manager, and a development build has no bundle,
/// so both keep the browser download.
fn in_app_supported() -> bool {
    use tauri::utils::{config::BundleType, platform::bundle_type};
    !cfg!(debug_assertions)
        && matches!(
            bundle_type(),
            Some(BundleType::Nsis | BundleType::Msi | BundleType::AppImage | BundleType::App)
        )
}

fn select_update(
    releases: Vec<Release>,
    current: &str,
    os: &str,
    arch: &str,
    in_app_supported: bool,
) -> Result<UpdateCheck, CommandError> {
    let current_version =
        Version::parse(current).map_err(|_| error("Invalid installed version."))?;
    let latest = releases
        .into_iter()
        .filter_map(|release| {
            let version = Version::parse(
                release
                    .tag_name
                    .strip_prefix('v')
                    .unwrap_or(&release.tag_name),
            )
            .ok()?;
            // The release workflow marks all 0.x versions as prereleases. Accept
            // those numeric versions, but never alpha/beta/RC or 1.x prereleases.
            if release.draft
                || !version.pre.is_empty()
                || (release.prerelease && version.major > 0)
                || !version.cmp_precedence(&current_version).is_gt()
            {
                return None;
            }
            Some((version, release))
        })
        .max_by(|(a, _), (b, _)| a.cmp_precedence(b));
    let update = if let Some((version, release)) = latest {
        let download = installer_names(&version, os, arch)
            .iter()
            .find_map(|name| {
                release.assets.iter().find(|asset| {
                    asset.name == *name && asset.state == "uploaded" && asset.size > 0
                })
            })
            .map(|asset| {
                Ok(Download {
                    name: asset.name.clone(),
                    size: asset.size,
                    url: repository_url(&["download", &release.tag_name, &asset.name])?,
                })
            })
            .transpose()?;
        // Releases published before the updater existed have no manifest and
        // keep the browser download.
        let manifest_url = release
            .assets
            .iter()
            .any(|asset| {
                asset.name == MANIFEST_ASSET && asset.state == "uploaded" && asset.size > 0
            })
            .then(|| repository_url(&["download", &release.tag_name, MANIFEST_ASSET]))
            .transpose()?;
        Some(ReleaseUpdate {
            version: version.to_string(),
            notes: release.body.unwrap_or_default(),
            published_at: release.published_at,
            release_url: repository_url(&["tag", &release.tag_name])?,
            download,
            in_app: in_app_supported && manifest_url.is_some(),
            manifest_url,
        })
    } else {
        None
    };
    Ok(UpdateCheck {
        current_version: current.to_owned(),
        update,
    })
}

#[tauri::command]
pub async fn update_open(
    state: State<'_, UpdateService>,
    target: UpdateTarget,
) -> Result<(), CommandError> {
    let url = {
        let cached = state.cached.lock().await;
        let update = cached
            .as_ref()
            .and_then(|(_, check)| check.update.as_ref())
            .ok_or_else(|| error("Check for updates before opening a release."))?;
        match target {
            UpdateTarget::Release => update.release_url.clone(),
            UpdateTarget::Download => update
                .download
                .as_ref()
                .ok_or_else(|| error("No installer is available for this device."))?
                .url
                .clone(),
        }
    };
    tauri::async_runtime::spawn_blocking(move || webbrowser::open(&url))
        .await
        .map_err(|_| error("Could not open your browser. Please try again."))?
        .map_err(|_| {
            error("Could not open your browser. Please check your default browser and try again.")
        })
}

/// The offered release, if it can be installed in-app. The webview names no
/// version or URL; both come from the last successful check.
async fn offered(state: &UpdateService) -> Result<(String, Url), CommandError> {
    let cached = state.cached.lock().await;
    let update = cached
        .as_ref()
        .and_then(|(_, check)| check.update.as_ref())
        .ok_or_else(|| error("Check for updates before downloading one."))?;
    let manifest = update
        .manifest_url
        .as_deref()
        .filter(|_| update.in_app)
        .ok_or_else(|| {
            error("This installation can’t update itself. Download the installer instead.")
        })?;
    let url = Url::parse(manifest).map_err(|_| error("Invalid release address."))?;
    Ok((update.version.clone(), url))
}

fn updater_error(err: tauri_plugin_updater::Error) -> CommandError {
    use tauri_plugin_updater::Error as E;
    match err {
        E::Minisign(_)
        | E::SignatureUtf8(_)
        | E::Base64(_)
        | E::SignedVersionMismatch { .. }
        | E::MissingSignedVersion => error(
            "The update failed its signature check and was discarded. Download the installer from GitHub instead.",
        ),
        E::TargetNotFound(_) | E::TargetsNotFound(_) | E::ReleaseNotFound => {
            error("This release has no in-app update for this device. Download the installer instead.")
        }
        E::Reqwest(_) | E::Network(_) => {
            error("Could not download the update. Check your connection and try again.")
        }
        E::AuthenticationFailed => error("Installation was not authorized."),
        _ => error("The update could not be installed. Download the installer from GitHub instead."),
    }
}

#[tauri::command]
pub async fn update_download(
    app: AppHandle,
    state: State<'_, UpdateService>,
    on_event: Channel<DownloadEvent>,
) -> Result<(), CommandError> {
    let (version, manifest) = offered(&state).await?;
    let cancel = CancellationToken::new();
    {
        let mut package = state.package.lock().await;
        match &*package {
            Package::Downloading { .. } => return Err(error("The update is already downloading.")),
            Package::Installing => return Err(error("The update is already installing.")),
            Package::Ready { update, .. } if update.version == version => {
                let _ = on_event.send(DownloadEvent::Verified);
                return Ok(());
            }
            _ => {}
        }
        *package = Package::Downloading {
            cancel: cancel.clone(),
        };
    }
    let oversized = AtomicBool::new(false);
    let result = tokio::select! {
        result = download(&app, &version, manifest, &on_event, &cancel, &oversized) => result,
        () = cancel.cancelled() => Err(error(if oversized.load(Ordering::Relaxed) {
            "The update package is larger than expected and was discarded."
        } else {
            "Download cancelled."
        })),
    };
    let mut package = state.package.lock().await;
    match result {
        Ok((update, bytes)) => {
            *package = Package::Ready {
                update: Box::new(update),
                bytes: Arc::new(bytes),
            };
            let _ = on_event.send(DownloadEvent::Verified);
            Ok(())
        }
        Err(err) => {
            *package = Package::None;
            Err(err)
        }
    }
}

async fn download(
    app: &AppHandle,
    version: &str,
    manifest: Url,
    on_event: &Channel<DownloadEvent>,
    cancel: &CancellationToken,
    oversized: &AtomicBool,
) -> Result<(tauri_plugin_updater::Update, Vec<u8>), CommandError> {
    let expected = Version::parse(version).map_err(|_| error("Invalid release version."))?;
    // The manifest must announce exactly the release discovery chose, so a
    // stale or swapped manifest cannot redirect the install to another version.
    let updater = app
        .updater_builder()
        .endpoints(vec![manifest])
        .map_err(updater_error)?
        .timeout(Duration::from_secs(30))
        .version_comparator(move |current, remote| {
            remote.version == expected && remote.version > current
        })
        .build()
        .map_err(updater_error)?;
    let update = updater
        .check()
        .await
        .map_err(updater_error)?
        .ok_or_else(|| error("This release is no longer an update for this device."))?;
    let mut downloaded = 0u64;
    let mut started = false;
    let mut last = Instant::now();
    let bytes = update
        .download(
            |chunk, total| {
                if !started {
                    started = true;
                    let _ = on_event.send(DownloadEvent::Started { total });
                }
                downloaded += chunk as u64;
                if downloaded > total.unwrap_or(MAX_PACKAGE_BYTES).min(MAX_PACKAGE_BYTES) {
                    oversized.store(true, Ordering::Relaxed);
                    cancel.cancel();
                }
                // Throttle UI updates; the final total is sent below.
                if last.elapsed() >= Duration::from_millis(100) {
                    last = Instant::now();
                    let _ = on_event.send(DownloadEvent::Progress { downloaded, total });
                }
            },
            || {},
        )
        .await
        .map_err(updater_error)?;
    if oversized.load(Ordering::Relaxed) {
        return Err(error(
            "The update package is larger than expected and was discarded.",
        ));
    }
    let _ = on_event.send(DownloadEvent::Progress {
        downloaded,
        total: Some(downloaded),
    });
    Ok((update, bytes))
}

#[tauri::command]
pub async fn update_cancel(state: State<'_, UpdateService>) -> Result<(), CommandError> {
    let mut package = state.package.lock().await;
    match &*package {
        Package::Downloading { cancel } => cancel.cancel(),
        Package::Ready { .. } => *package = Package::None,
        Package::None | Package::Installing => {}
    }
    Ok(())
}

/// Locks the vault, installs the verified package and restarts Selai. On
/// Windows the installer replaces the process; elsewhere the app relaunches.
#[tauri::command]
pub async fn update_install(
    app: AppHandle,
    state: State<'_, UpdateService>,
    app_state: State<'_, AppState>,
) -> Result<(), CommandError> {
    let (version, _) = offered(&state).await?;
    let (update, bytes) = {
        let mut package = state.package.lock().await;
        match std::mem::replace(&mut *package, Package::Installing) {
            Package::Ready { update, bytes } if update.version == version => (update, bytes),
            other => {
                let installing = matches!(other, Package::Installing);
                *package = other;
                return Err(error(if installing {
                    "The update is already installing."
                } else {
                    "Download the update before installing it."
                }));
            }
        }
    };
    // Seal the encrypted database and end sessions before files are replaced.
    // A vault that never opened has nothing to seal.
    if let Ok(vault) = app_state.vault() {
        if let Err(err) = vault.lock(true).await {
            *state.package.lock().await = Package::Ready { update, bytes };
            return Err(err);
        }
    }
    let installer = update.clone();
    let package = bytes.clone();
    let installed =
        tauri::async_runtime::spawn_blocking(move || installer.install(package.as_slice()))
            .await
            .map_err(|_| error("The update could not be installed."))
            .and_then(|result| result.map_err(updater_error));
    match installed {
        Ok(()) => app.restart(),
        Err(err) => {
            // The package stays verified; the user can retry or download manually.
            *state.package.lock().await = Package::Ready { update, bytes };
            Err(err)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn release(tag: &str) -> Release {
        serde_json::from_value(json!({"tag_name":tag,"body":"Changes","published_at":"2026-10-20T00:00:00Z",
            "assets":[{"name":format!("Selai_{}_x64-setup.exe",tag.trim_start_matches('v')),"size":1234,"state":"uploaded"}]})).unwrap()
    }

    #[test]
    fn chooses_highest_semver_not_publish_order_and_accepts_numeric_zero_prereleases() {
        let mut zero = release("v0.3.10");
        zero.prerelease = true;
        let mut rc = release("v0.4.0-rc.1");
        rc.prerelease = true;
        let mut draft = release("v2.0.0");
        draft.draft = true;
        let mut prerelease = release("v1.0.0");
        prerelease.prerelease = true;
        let check = select_update(
            vec![
                release("v0.3.9"),
                zero,
                rc,
                draft,
                prerelease,
                release("garbage"),
            ],
            "0.3.1",
            "windows",
            "x86_64",
            false,
        )
        .unwrap();
        let update = check.update.unwrap();
        assert_eq!(update.version, "0.3.10");
        assert_eq!(
            update.download.unwrap().url,
            "https://github.com/f3ci/selai/releases/download/v0.3.10/Selai_0.3.10_x64-setup.exe"
        );
    }

    #[test]
    fn never_offers_same_version_build_metadata_or_downgrade() {
        assert!(select_update(
            vec![release("v0.3.1+build.2"), release("v0.2.9")],
            "0.3.1",
            "windows",
            "x86_64",
            false
        )
        .unwrap()
        .update
        .is_none());
    }

    #[test]
    fn matches_os_arch_and_prefers_windows_exe_over_msi() {
        let mut r = release("v0.3.2");
        for name in [
            "Selai_0.3.2_x64_en-US.msi",
            "Selai_0.3.2_aarch64.dmg",
            "Selai_0.3.2_amd64.AppImage",
        ] {
            r.assets.push(Asset {
                name: name.into(),
                size: 12,
                state: "uploaded".into(),
            });
        }
        let check = select_update(vec![r], "0.3.1", "macos", "aarch64", false).unwrap();
        assert_eq!(
            check.update.unwrap().download.unwrap().name,
            "Selai_0.3.2_aarch64.dmg"
        );
        assert_eq!(
            select_update(vec![release("v0.3.2")], "0.3.1", "windows", "x86_64", false)
                .unwrap()
                .update
                .unwrap()
                .download
                .unwrap()
                .name,
            "Selai_0.3.2_x64-setup.exe"
        );
    }

    #[test]
    fn missing_or_incomplete_installer_keeps_release_notes_available_without_wrong_arch_download() {
        let mut r = release("v0.3.2");
        r.assets[0].state = "new".into();
        assert!(select_update(vec![r], "0.3.1", "windows", "x86_64", false)
            .unwrap()
            .update
            .unwrap()
            .download
            .is_none());
        let update = select_update(
            vec![release("v0.3.2")],
            "0.3.1",
            "windows",
            "aarch64",
            false,
        )
        .unwrap()
        .update
        .unwrap();
        assert!(update.download.is_none());
        assert_eq!(
            update.release_url,
            "https://github.com/f3ci/selai/releases/tag/v0.3.2"
        );
    }

    #[test]
    fn in_app_install_needs_a_published_manifest_and_a_supported_bundle() {
        let legacy = select_update(vec![release("v0.3.2")], "0.3.1", "windows", "x86_64", true)
            .unwrap()
            .update
            .unwrap();
        assert!(
            !legacy.in_app,
            "releases without latest.json keep the browser download"
        );
        assert!(legacy.manifest_url.is_none());

        let with_manifest = || {
            let mut r = release("v0.3.2");
            r.assets.push(Asset {
                name: MANIFEST_ASSET.into(),
                size: 900,
                state: "uploaded".into(),
            });
            r
        };
        let update = select_update(vec![with_manifest()], "0.3.1", "windows", "x86_64", true)
            .unwrap()
            .update
            .unwrap();
        assert!(update.in_app);
        assert_eq!(
            update.manifest_url.as_deref(),
            Some("https://github.com/f3ci/selai/releases/download/v0.3.2/latest.json")
        );
        let deb = select_update(vec![with_manifest()], "0.3.1", "linux", "x86_64", false)
            .unwrap()
            .update
            .unwrap();
        assert!(!deb.in_app, "unsupported bundles never install in-app");

        let mut partial = with_manifest();
        partial.assets.last_mut().unwrap().state = "new".into();
        assert!(
            !select_update(vec![partial], "0.3.1", "windows", "x86_64", true)
                .unwrap()
                .update
                .unwrap()
                .in_app
        );
    }

    /// A malformed updater section stops the plugin, and with it the app, at
    /// startup. Installed copies can only ever verify against this key.
    #[test]
    fn shipped_updater_config_parses_and_requires_version_bound_signatures() {
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let updater = conf["plugins"]["updater"].clone();
        let config: tauri_plugin_updater::Config = serde_json::from_value(updater).unwrap();
        assert!(config.require_signed_version);
        assert!(!config.allow_downgrades);
        assert!(!config.dangerous_insecure_transport_protocol);
        assert!(
            config.endpoints.is_empty(),
            "endpoints come from the chosen release"
        );
        let key = base64::Engine::decode(
            &base64::engine::general_purpose::STANDARD,
            config.pubkey.trim(),
        )
        .unwrap();
        assert!(String::from_utf8(key)
            .unwrap()
            .starts_with("untrusted comment: minisign public key"));
    }

    #[test]
    fn manifest_url_is_never_sent_to_the_webview() {
        let mut r = release("v0.3.2");
        r.assets.push(Asset {
            name: MANIFEST_ASSET.into(),
            size: 900,
            state: "uploaded".into(),
        });
        let check = select_update(vec![r], "0.3.1", "windows", "x86_64", true).unwrap();
        let json = serde_json::to_value(&check).unwrap();
        assert_eq!(json["update"]["inApp"], true);
        assert!(json["update"].get("manifestUrl").is_none());
    }

    #[tokio::test]
    async fn handles_github_rate_limits_and_invalid_responses() {
        use wiremock::{matchers::method, Mock, MockServer, ResponseTemplate};
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(429))
            .mount(&server)
            .await;
        let err = fetch_releases(&Client::new(), &server.uri())
            .await
            .err()
            .unwrap();
        assert!(err.message.contains("limiting"));
        server.reset().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(200).set_body_string("invalid"))
            .mount(&server)
            .await;
        assert!(fetch_releases(&Client::new(), &server.uri())
            .await
            .err()
            .unwrap()
            .message
            .contains("invalid"));
        server.reset().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!([])))
            .mount(&server)
            .await;
        assert!(fetch_releases(&Client::new(), &server.uri())
            .await
            .unwrap()
            .is_empty());
    }
}
