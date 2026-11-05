/** Load and shrink a wallpaper so it fits comfortably in browser storage. */

const MAX_SOURCE_BYTES = 30 * 1024 * 1024;
// localStorage is small on some platforms. Characters, not decoded bytes, count.
const MAX_DATA_URL_LENGTH = 2_200_000;

const ATTEMPTS = [
  { edge: 1920, quality: 0.84 },
  { edge: 1440, quality: 0.78 },
  { edge: 1080, quality: 0.7 },
];

function loadImage(file: File): Promise<{ image: HTMLImageElement; url: string }> {
  const url = URL.createObjectURL(file);
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve({ image, url });
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('That file could not be read as an image.'));
    };
    image.src = url;
  });
}

function themeBackground(): string {
  const colour = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
  return colour || '#191b1d';
}

function encode(image: HTMLImageElement, edge: number, quality: number): string {
  const naturalWidth = image.naturalWidth || image.width;
  const naturalHeight = image.naturalHeight || image.height;
  if (!naturalWidth || !naturalHeight) throw new Error('That image has no usable dimensions.');

  const scale = Math.min(1, edge / Math.max(naturalWidth, naturalHeight));
  const width = Math.max(1, Math.round(naturalWidth * scale));
  const height = Math.max(1, Math.round(naturalHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('This device cannot prepare an image background.');

  // Fill first so transparent PNGs do not turn black when encoded as JPEG.
  context.fillStyle = themeBackground();
  context.fillRect(0, 0, width, height);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(image, 0, 0, width, height);
  return canvas.toDataURL('image/jpeg', quality);
}

/** Returns a JPEG data URL sized for a local wallpaper slot. */
export async function backgroundImageFromFile(file: File): Promise<string> {
  if (!file.type.startsWith('image/')) {
    throw new Error('Choose an image file such as PNG, JPEG, WebP, or GIF.');
  }
  if (file.size > MAX_SOURCE_BYTES) {
    throw new Error('Choose an image under 30 MB.');
  }

  const { image, url } = await loadImage(file);
  try {
    let last = '';
    for (const attempt of ATTEMPTS) {
      last = encode(image, attempt.edge, attempt.quality);
      if (last.length <= MAX_DATA_URL_LENGTH) return last;
    }
    throw new Error('That image is too detailed to store. Try a smaller or simpler image.');
  } finally {
    URL.revokeObjectURL(url);
  }
}
