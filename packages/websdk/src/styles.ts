/**
 * Widget styles.
 *
 * Injected into a shadow root, so nothing here can leak into the host page and
 * nothing on the host page can reach in. An embeddable widget that inherits the
 * host's CSS looks broken on three sites out of four; one that leaks its own
 * breaks the host.
 *
 * Colours come from custom properties so an integrator can theme the widget by
 * setting them on the container, without needing a stylesheet override.
 */
export const STYLES = /* css */ `
:host {
  --kyc-bg: #ffffff;
  --kyc-fg: #16191d;
  --kyc-dim: #5c6672;
  --kyc-border: #dfe3e9;
  --kyc-accent: #2f5fd0;
  --kyc-accent-fg: #ffffff;
  --kyc-ok: #1f7a4d;
  --kyc-ok-bg: #e3f4ea;
  --kyc-accent-soft: rgba(47, 95, 208, 0.08);
  --kyc-err: #b3261e;
  --kyc-err-bg: #fbe6e5;
  --kyc-warn: #96690b;
  --kyc-warn-bg: #fbf1d9;
  --kyc-radius: 10px;
  --kyc-font: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;

  display: block;
  color: var(--kyc-fg);
  font-family: var(--kyc-font);
  font-size: 15px;
  line-height: 1.5;
}

@media (prefers-color-scheme: dark) {
  :host {
    --kyc-bg: #1b1e24;
    --kyc-fg: #e8eaee;
    --kyc-dim: #9aa4b2;
    --kyc-border: #2f343d;
    --kyc-accent: #7aa2f7;
    --kyc-accent-fg: #14161a;
    --kyc-ok: #6ed69b;
    --kyc-ok-bg: #17301f;
    --kyc-err: #f28b82;
    --kyc-err-bg: #3a1f1d;
    --kyc-warn: #e3b341;
    --kyc-warn-bg: #322813;
  }
}

* { box-sizing: border-box; }

.card {
  background: var(--kyc-bg);
  border: 1px solid var(--kyc-border);
  border-radius: var(--kyc-radius);
  padding: 20px;
  max-width: 460px;
}

h2 { font-size: 17px; margin: 0 0 4px; }
p  { margin: 0 0 14px; color: var(--kyc-dim); font-size: 14px; }
p.lead { color: var(--kyc-fg); }

ol.steps { list-style: none; margin: 0 0 16px; padding: 0; }
ol.steps li {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 0;
  border-bottom: 1px solid var(--kyc-border);
  font-size: 14px;
}
ol.steps li:last-child { border-bottom: none; }
ol.steps li.done { color: var(--kyc-dim); }

/* An outstanding step is a button spanning the row. It has to look pressable —
   the previous version rendered the same content as inert text, so people
   clicked it and nothing happened. */
button.step-go {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 4px 6px;
  margin: -4px -6px;
  border: none;
  border-radius: 7px;
  background: none;
  color: inherit;
  font: inherit;
  font-size: 14px;
  text-align: left;
  cursor: pointer;
}
button.step-go:hover { background: var(--kyc-accent-soft, rgba(47,95,208,0.08)); }
button.step-go:hover .tick { border-color: var(--kyc-accent); }
button.step-go:focus-visible { outline: 2px solid var(--kyc-accent); outline-offset: 1px; }
/* A chevron, so the row reads as somewhere to go rather than a checkbox. */
button.step-go::after {
  content: '›';
  margin-left: auto;
  color: var(--kyc-dim);
  font-size: 17px;
  line-height: 1;
}

/* Offered, not finished. The tick outline stays empty. */
button.step-go.optional .done-note { color: var(--kyc-dim); }

.chip-qr {
  display: flex;
  justify-content: center;
  padding: 12px;
  background: #ffffff;
  border: 1px solid var(--kyc-border, #dfe3e9);
  border-radius: 8px;
  margin: 4px 0 10px;
}
.chip-qr svg { width: 180px; height: 180px; }

a.as-button {
  display: block;
  text-align: center;
  text-decoration: none;
  box-sizing: border-box;
}
a.primary.as-button:hover { filter: brightness(0.95); }

.back-link {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border: none;
  background: none;
  padding: 0;
  margin: 0 0 12px;
  font: inherit;
  font-size: 13px;
  color: var(--kyc-dim);
  cursor: pointer;
}
.back-link:hover { color: var(--kyc-accent); }
.back-link:focus-visible { outline: 2px solid var(--kyc-accent); outline-offset: 2px; border-radius: 4px; }

/* A completed row stays reachable but reads as settled, not outstanding. */
button.step-go.done { color: var(--kyc-dim); }
button.step-go.done::after { content: ''; }

.done-note {
  margin-left: auto;
  font-size: 11px;
  font-weight: 600;
  color: var(--kyc-ok, #1f7a4d);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.tick {
  flex: 0 0 20px;
  height: 20px;
  border-radius: 50%;
  border: 1.5px solid var(--kyc-border);
  display: grid;
  place-items: center;
  font-size: 11px;
  font-weight: 700;
}
.tick.done { background: var(--kyc-ok-bg); border-color: var(--kyc-ok-bg); color: var(--kyc-ok); }

button {
  font: inherit;
  font-weight: 600;
  font-size: 14px;
  padding: 10px 16px;
  border-radius: 8px;
  border: 1px solid var(--kyc-border);
  background: var(--kyc-bg);
  color: var(--kyc-fg);
  cursor: pointer;
}
button:hover:not(:disabled) { border-color: var(--kyc-accent); }
button:disabled { opacity: 0.55; cursor: not-allowed; }
/* The chip step's main action is a link, not a button — it opens an app. It
   still has to look like the main action. */
button.primary,
a.primary.as-button {
  background: var(--kyc-accent);
  border-color: var(--kyc-accent);
  color: var(--kyc-accent-fg);
  width: 100%;
}
button:focus-visible { outline: 2px solid var(--kyc-accent); outline-offset: 2px; }
.actions { display: flex; gap: 8px; flex-wrap: wrap; }
.actions button { flex: 1 1 auto; }

video, .shot {
  width: 100%;
  border-radius: 8px;
  background: #000;
  aspect-ratio: 3 / 2;
  object-fit: cover;
  margin-bottom: 12px;
  display: block;
}

.note {
  border-radius: 8px;
  padding: 10px 12px;
  font-size: 13.5px;
  margin-bottom: 14px;
}
.note.err { background: var(--kyc-err-bg); color: var(--kyc-err); }
.note.sim {
  background: var(--kyc-warn-bg, #fbf1d9);
  color: var(--kyc-warn, #96690b);
  font-weight: 600;
}
.note.ok  { background: var(--kyc-ok-bg);  color: var(--kyc-ok); }

.reasons { margin: 8px 0 0; padding-left: 18px; font-size: 13.5px; }

.hint { font-size: 12.5px; color: var(--kyc-dim); margin: 10px 0 0; }

/* Visible only to screen readers: status changes are announced without
   the layout jumping. */
.sr {
  position: absolute;
  width: 1px; height: 1px;
  padding: 0; margin: -1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
  border: 0;
}

.spinner { color: var(--kyc-dim); font-size: 14px; padding: 8px 0; }

input[type="file"] { display: none; }

form label {
  display: block;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--kyc-dim);
  margin: 0 0 4px;
}
form input {
  width: 100%;
  font: inherit;
  font-size: 14px;
  padding: 9px 10px;
  margin-bottom: 12px;
  border: 1px solid var(--kyc-border);
  border-radius: 8px;
  background: var(--kyc-bg);
  color: var(--kyc-fg);
}
form input:focus-visible { outline: 2px solid var(--kyc-accent); outline-offset: 1px; }
`;
