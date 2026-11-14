// Photos on notes and comments: pick from the camera or the library, shrunk on the device (at most 2048 px, JPEG) so
// a phone's 12-megapixel shot doesn't take a minute to send, shown as thumbnails you can remove before sending.
import { esc, toast } from './util.js';
import { icon } from './icons.js';

const MAX = 2048;

export const photoInputHtml = () =>
  `<label class="btn photo-btn" title="Attach photos or screenshots">${icon('image', 16)}<span>Photo</span><input type="file" accept="image/*" multiple hidden data-photos></label>`;

/** the photos picked in a form, as data URLs */
export const readPhotos = (form) => [...(form.querySelectorAll('.photo-list [data-photo]') || [])].map((el) => el.dataset.photo);

export const photosHtml = (urls) => (urls.length ? `<div class="photos">${urls.map((u) => `<a href="${esc(u)}" target="_blank" rel="noopener"><img src="${esc(u)}" alt="A photo" loading="lazy"></a>`).join('')}</div>` : '');

async function shrink(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = () => rej(new Error("That picture couldn't be read"));
      i.src = url;
    });
    const k = Math.min(1, MAX / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(img.naturalWidth * k));
    c.height = Math.max(1, Math.round(img.naturalHeight * k));
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    // PNG screenshots stay sharp; photos become JPEG
    return file.type === 'image/png' && file.size < 1.5 * 1048576 ? c.toDataURL('image/png') : c.toDataURL('image/jpeg', 0.85);
  } finally {
    URL.revokeObjectURL(url);
  }
}

document.addEventListener('change', async (e) => {
  const input = e.target.closest?.('[data-photos]');
  if (!input) return;
  const form = input.closest('form');
  const list = form?.querySelector('.photo-list');
  if (!list) return;
  for (const file of [...input.files].slice(0, 8)) {
    try {
      const data = await shrink(file);
      const wrap = document.createElement('span');
      wrap.className = 'photo-thumb';
      wrap.dataset.photo = data;
      wrap.innerHTML = `<img src="${data}" alt=""><button type="button" class="mini" aria-label="Remove">${icon('x', 12)}</button>`;
      wrap.querySelector('button').onclick = () => wrap.remove();
      list.append(wrap);
    } catch (err) {
      toast(err.message);
    }
  }
  input.value = '';
});
