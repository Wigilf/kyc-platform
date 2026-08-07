import { useCallback, useEffect, useRef, useState } from 'react';
import { api, apiOrigin } from '../api';

/**
 * Looking at the document.
 *
 * The console listed documents by type and status and offered no way to see
 * one, which meant a reviewer approving an applicant was doing so on the
 * strength of a row in a table. Manual review is the fallback for everything
 * the automation declines to decide, so that was the queue's whole purpose
 * missing.
 *
 * Images are fetched through short-lived signed links minted per view, never
 * embedded as data or served from a permanent URL: the link is what carries
 * authorisation, and minting one is the moment recorded in the audit log.
 */

export interface DocumentImage {
  id: string;
  storageKey: string;
  side: string;
  contentType: string;
}

const SIDE_LABEL: Record<string, string> = {
  FRONT_SIDE: 'Front',
  BACK_SIDE: 'Back',
  PAGE: 'Page',
};

/** Presigned links expire; refresh a little before they do rather than on error. */
const TTL_SECONDS = 300;
const REFRESH_AFTER_MS = (TTL_SECONDS - 30) * 1000;

export function DocumentViewer({
  images,
  extracted,
  title,
}: {
  images: DocumentImage[];
  extracted?: Record<string, unknown> | null;
  title: string;
}) {
  const [open, setOpen] = useState(false);
  const [index, setIndex] = useState(0);

  if (images.length === 0) {
    return (
      <span className="muted" title="No image was stored for this document">
        no image
      </span>
    );
  }

  return (
    <>
      <div className="doc-thumbs">
        {images.map((image, i) => (
          <button
            key={image.id}
            type="button"
            className="doc-thumb"
            onClick={() => {
              setIndex(i);
              setOpen(true);
            }}
            aria-label={`View ${SIDE_LABEL[image.side] ?? image.side} of ${title}`}
          >
            <SignedImage image={image} alt={`${SIDE_LABEL[image.side] ?? image.side}`} />
            <span>{SIDE_LABEL[image.side] ?? image.side}</span>
          </button>
        ))}
      </div>

      {open ? (
        <Lightbox
          images={images}
          index={index}
          onIndex={setIndex}
          onClose={() => setOpen(false)}
          extracted={extracted}
          title={title}
        />
      ) : null}
    </>
  );
}

/**
 * An image behind a signed link.
 *
 * The link is requested when the element mounts and renewed before it lapses,
 * so a reviewer who leaves a case open on a second monitor does not come back
 * to a broken image.
 */
function SignedImage({
  image,
  alt,
  className,
  style,
}: {
  image: DocumentImage;
  alt: string;
  className?: string;
  style?: React.CSSProperties;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const load = async () => {
      try {
        const res = await api.post<{ url: string }>('/v1/files/presign', {
          storageKey: image.storageKey,
          ttlSeconds: TTL_SECONDS,
        });
        if (cancelled) return;
        // The API returns a path; resolve it against the API's origin, which is
        // a different host from the dashboard in every real deployment.
        setUrl(new URL(res.url, apiOrigin()).toString());
        setError(null);
        timer = setTimeout(load, REFRESH_AFTER_MS);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Could not load the image');
      }
    };

    void load();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [image.storageKey]);

  if (error) return <span className="doc-error">{error}</span>;
  if (!url) return <span className="doc-loading" aria-busy="true" />;
  return <img src={url} alt={alt} className={className} style={style} />;
}

/** Full-size view: zoom, rotate, and the extracted fields beside the image. */
function Lightbox({
  images,
  index,
  onIndex,
  onClose,
  extracted,
  title,
}: {
  images: DocumentImage[];
  index: number;
  onIndex: (i: number) => void;
  onClose: () => void;
  extracted?: Record<string, unknown> | null;
  title: string;
}) {
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const closeRef = useRef<HTMLButtonElement>(null);

  const image = images[index]!;

  // Escape closes, arrows move between sides. A reviewer comparing the front
  // and back of a card should not have to reach for the mouse.
  const onKey = useCallback(
    (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key === 'ArrowRight' && index < images.length - 1) onIndex(index + 1);
      if (event.key === 'ArrowLeft' && index > 0) onIndex(index - 1);
    },
    [index, images.length, onClose, onIndex],
  );

  useEffect(() => {
    window.addEventListener('keydown', onKey);
    closeRef.current?.focus();
    // Stop the page behind scrolling while the overlay is up.
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [onKey]);

  // Reset the transform when moving to another side, so the second image does
  // not arrive upside down because the first one needed rotating.
  useEffect(() => {
    setZoom(1);
    setRotation(0);
  }, [index]);

  const readBy = typeof extracted?.readBy === 'string' ? extracted.readBy : null;
  // A reader whose name is not a real provider invented these values to agree
  // with what the applicant declared, not with the photograph beside them.
  const simulated = readBy !== null && readBy.startsWith('mock');

  const fields = Object.entries(extracted ?? {}).filter(
    ([k, v]) =>
      k !== 'readBy' && v !== null && v !== undefined && v !== '' && typeof v !== 'object',
  );

  return (
    <div
      className="lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={`${title} — document image`}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="lightbox-inner">
        <header>
          <strong>{title}</strong>
          <span className="muted">{SIDE_LABEL[image.side] ?? image.side}</span>
          <div className="lightbox-tools">
            <button type="button" onClick={() => setZoom((z) => Math.max(0.25, z - 0.25))} aria-label="Zoom out">
              −
            </button>
            <span className="mono">{Math.round(zoom * 100)}%</span>
            <button type="button" onClick={() => setZoom((z) => Math.min(6, z + 0.25))} aria-label="Zoom in">
              +
            </button>
            <button type="button" onClick={() => setRotation((r) => (r + 90) % 360)} aria-label="Rotate">
              ⟳
            </button>
            <button type="button" ref={closeRef} onClick={onClose} aria-label="Close">
              ✕
            </button>
          </div>
        </header>

        <div className="lightbox-body">
          <div className="lightbox-stage">
            <SignedImage
              image={image}
              alt={`${title}, ${SIDE_LABEL[image.side] ?? image.side}`}
              style={{
                transform: `scale(${zoom}) rotate(${rotation}deg)`,
                transformOrigin: 'center center',
              }}
            />
          </div>

          {fields.length > 0 ? (
            <aside className="lightbox-fields">
              <h4>Read from this document</h4>
              {simulated ? (
                <p className="doc-simulated">
                  <strong>Simulated reader.</strong> These values were generated
                  to match what the applicant declared, not read from the image.
                  Do not compare them against the photograph — they will agree
                  when they should not, and differ when they should not.
                </p>
              ) : null}
              <dl>
                {fields.map(([key, value]) => (
                  <div key={key}>
                    <dt>{key.replace(/([A-Z])/g, ' $1').toLowerCase()}</dt>
                    <dd className="mono">{String(value)}</dd>
                  </div>
                ))}
              </dl>
              <p className="muted">
                {simulated
                  ? 'Turn on a real reader to compare these against the image.'
                  : 'Compare against the declared details on the left of the case. A mismatch the automation missed is the thing worth catching here.'}
                {readBy ? ` Read by ${readBy}.` : ''}
              </p>
            </aside>
          ) : null}
        </div>

        {images.length > 1 ? (
          <footer className="lightbox-nav">
            <button type="button" disabled={index === 0} onClick={() => onIndex(index - 1)}>
              ← Previous
            </button>
            <span className="muted">
              {index + 1} of {images.length}
            </span>
            <button
              type="button"
              disabled={index === images.length - 1}
              onClick={() => onIndex(index + 1)}
            >
              Next →
            </button>
          </footer>
        ) : null}
      </div>
    </div>
  );
}
