import { KycApiError, KycClient } from './client.js';
import { STYLES } from './styles.js';
import type {
  ApplicantStatus,
  KycEvent,
  KycHandle,
  KycMountOptions,
  Requirement,
  RequirementsResponse,
} from './types.js';

/**
 * The applicant-facing verification widget.
 *
 * Deliberately small and dependency-free: it renders into a shadow root so it
 * cannot collide with the host page, and it speaks only to the applicant-scoped
 * endpoints. Everything it knows about what to collect comes from the level
 * definition via /requirements — the widget hard-codes no flow of its own, so
 * changing a level in the dashboard changes what applicants are asked for
 * without shipping new SDK code.
 */

/** Applicant-facing copy. Keyed so a second locale is a data change. */
const COPY: Record<string, string> = {
  title: 'Verify your identity',
  intro: 'This usually takes a couple of minutes.',
  submit: 'Submit for review',
  submitting: 'Submitting…',
  takePhoto: 'Use camera',
  choosePhoto: 'Choose a file',
  capture: 'Capture',
  retake: 'Retake',
  usePhoto: 'Use this photo',
  cancel: 'Cancel',
  uploading: 'Uploading…',
  loading: 'Loading…',
  allDone: 'Everything we need is here.',
  inReview: 'Thanks — your details are with our team.',
  inReviewBody: 'We will email you when the review is complete. You can close this page.',
  approved: 'You are verified.',
  approvedBody: 'Nothing further is needed.',
  rejectedRetry: 'We need you to try again.',
  rejectedFinal: 'We could not verify your identity.',
  rejectedFinalBody: 'Our team has reviewed this and the decision is final.',
  cameraDenied: 'Camera unavailable, so please choose a file instead.',
  genericError: 'Something went wrong. Please try again.',
};

const SIDE_LABEL: Record<string, string> = {
  FRONT_SIDE: 'front',
  BACK_SIDE: 'back',
  PAGE: 'page',
};

type View =
  | { kind: 'loading' }
  | { kind: 'checklist' }
  | { kind: 'details'; step: Requirement }
  | { kind: 'capture'; step: Requirement; docType: string; side: string }
  | { kind: 'review'; step: Requirement; docType: string; side: string; blob: Blob; url: string }
  | { kind: 'done' };

/**
 * The details form.
 *
 * A step with no document that satisfies it is asking the applicant for
 * information, not a file. The level says which fields it wants; anything not
 * listed here is not something this widget knows how to ask for, and is left to
 * the integrator to collect before minting the token.
 */
const FIELDS: Record<string, { label: string; type: string; autocomplete: string }> = {
  firstName: { label: 'First name', type: 'text', autocomplete: 'given-name' },
  lastName: { label: 'Last name', type: 'text', autocomplete: 'family-name' },
  dob: { label: 'Date of birth', type: 'date', autocomplete: 'bday' },
  country: { label: 'Country of residence (3-letter code)', type: 'text', autocomplete: 'country' },
  nationality: { label: 'Nationality (3-letter code)', type: 'text', autocomplete: '' },
  email: { label: 'Email', type: 'email', autocomplete: 'email' },
  phone: { label: 'Phone', type: 'tel', autocomplete: 'tel' },
  addressLine1: { label: 'Street address', type: 'text', autocomplete: 'address-line1' },
  addressCity: { label: 'City', type: 'text', autocomplete: 'address-level2' },
  addressPostCode: { label: 'Postcode', type: 'text', autocomplete: 'postal-code' },
};

export function mountWidget(options: KycMountOptions): KycHandle {
  const host =
    typeof options.container === 'string'
      ? document.querySelector<HTMLElement>(options.container)
      : options.container;
  if (!host) throw new Error(`KYC widget: container not found: ${String(options.container)}`);

  const baseUrl = (options.apiBaseUrl ?? window.location.origin).replace(/\/$/, '');
  const client = new KycClient(baseUrl, options.token, options.applicantId);

  const root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : null;
  if (!root) throw new Error('KYC widget: the container does not support shadow DOM.');

  const style = document.createElement('style');
  style.textContent = STYLES;
  root.append(style);

  const card = document.createElement('div');
  card.className = 'card';
  const live = document.createElement('div');
  live.className = 'sr';
  live.setAttribute('role', 'status');
  live.setAttribute('aria-live', 'polite');
  root.append(card, live);

  let view: View = { kind: 'loading' };
  let requirements: RequirementsResponse | null = null;
  let applicant: ApplicantStatus | null = null;
  let notice: { text: string; tone: 'err' | 'ok' } | null = null;
  let busy = false;
  let stream: MediaStream | null = null;
  let destroyed = false;

  const emit = (event: KycEvent) => options.onEvent?.(event);

  function announce(text: string) {
    live.textContent = text;
  }

  function fail(error: unknown) {
    const message =
      error instanceof KycApiError || error instanceof Error
        ? error.message
        : COPY.genericError!;
    notice = { text: message, tone: 'err' };
    emit({ type: 'error', message });
    options.onError?.(error instanceof Error ? error : new Error(message));
  }

  function stopCamera() {
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
  }

  async function load() {
    try {
      const [reqs, status] = await Promise.all([client.requirements(), client.status()]);
      requirements = reqs;
      applicant = status;
      view = restingView(status.reviewStatus) ? { kind: 'done' } : { kind: 'checklist' };
      emit({ type: 'loaded', status: status.reviewStatus });
    } catch (error) {
      fail(error);
    }
    render();
  }

  /** States where there is nothing for the applicant to do right now. */
  function restingView(status: string): boolean {
    return ['PENDING', 'QUEUED', 'APPROVED', 'REJECTED_FINAL', 'ON_HOLD'].includes(status);
  }

  // --- Rendering ------------------------------------------------------------
  //
  // Rebuilt wholesale on each state change. The widget is a handful of nodes and
  // the flow is strictly sequential, so a diffing layer would be more moving
  // parts than the thing it optimises.

  function render() {
    if (destroyed) return;
    card.replaceChildren();

    if (notice) {
      card.append(el('div', { class: `note ${notice.tone}` }, notice.text));
    }

    switch (view.kind) {
      case 'loading':
        card.append(el('div', { class: 'spinner' }, COPY.loading!));
        break;
      case 'checklist':
        renderChecklist();
        break;
      case 'details':
        renderDetails(view);
        break;
      case 'capture':
        renderCapture(view);
        break;
      case 'review':
        renderReview(view);
        break;
      case 'done':
        renderDone();
        break;
    }
  }

  function renderChecklist() {
    const reqs = requirements;
    if (!reqs) return;

    card.append(el('h2', {}, COPY.title!), el('p', {}, COPY.intro!));

    const list = el('ol', { class: 'steps' });
    // Only what the applicant can actually act on. Older API builds omit the
    // flag, in which case fall back to whether the step is document-shaped.
    const visible = reqs.allSteps.filter((s) => s.applicantFacing !== false);
    for (const step of visible) {
      const label =
        step.label ?? reqs.outstanding.find((o) => o.id === step.id)?.label ?? humanise(step.type);
      const li = el('li', { class: step.satisfied ? 'done' : '' });
      li.append(
        el('span', { class: `tick ${step.satisfied ? 'done' : ''}` }, step.satisfied ? '✓' : ''),
        el('span', {}, label),
      );
      list.append(li);
    }
    card.append(list);

    const next = reqs.outstanding[0];
    if (next) {
      // No document satisfies this step, so it is asking for information.
      if (next.acceptedDocumentTypes.length === 0) {
        const button = el('button', { class: 'primary' }, `Add your ${next.label.toLowerCase()}`);
        button.addEventListener('click', () => {
          emit({ type: 'step_started', stepId: next.id });
          notice = null;
          view = { kind: 'details', step: next };
          render();
        });
        card.append(button);
        return;
      }

      const docType = next.acceptedDocumentTypes[0] ?? 'PASSPORT';
      const side = next.requireBothSides ? 'FRONT_SIDE' : defaultSide(docType);
      const button = el('button', { class: 'primary' }, `Add ${next.label.toLowerCase()}`);
      button.addEventListener('click', () => {
        emit({ type: 'step_started', stepId: next.id, documentType: docType });
        startCapture(next, docType, side);
      });
      card.append(button);
      if (next.acceptedDocumentTypes.length > 1) {
        card.append(
          el(
            'p',
            { class: 'hint' },
            `Accepted: ${next.acceptedDocumentTypes.map(humanise).join(', ').toLowerCase()}.`,
          ),
        );
      }
    } else {
      card.append(el('p', { class: 'lead' }, COPY.allDone!));
      const submit = el('button', { class: 'primary' }, busy ? COPY.submitting! : COPY.submit!);
      if (busy) submit.setAttribute('disabled', 'true');
      submit.addEventListener('click', () => void doSubmit());
      card.append(submit);
    }
  }

  function renderDetails(state: Extract<View, { kind: 'details' }>) {
    card.append(
      el('h2', {}, state.step.label),
      el('p', {}, 'These must match the document you are about to upload.'),
    );

    const form = el('form') as HTMLFormElement;
    // Which fields the level wants is not exposed by /requirements, so ask for
    // the ones the widget can render and let the API reject anything invalid.
    const wanted = [
      'firstName', 'lastName', 'dob', 'country', 'email',
      'addressLine1', 'addressCity', 'addressPostCode',
    ];

    for (const name of wanted) {
      const spec = FIELDS[name]!;
      const id = `kyc-${name}`;
      const label = el('label', { for: id }, spec.label);
      const input = el('input', {
        id,
        name,
        type: spec.type,
        autocomplete: spec.autocomplete,
      }) as HTMLInputElement;
      if (name === 'country') input.maxLength = 3;
      form.append(label, input);
    }

    const save = el('button', { class: 'primary', type: 'submit' }, busy ? 'Saving…' : 'Continue');
    if (busy) save.setAttribute('disabled', 'true');
    form.append(save);

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const data = new FormData(form);
      const get = (name: string) => String(data.get(name) ?? '').trim();

      const info: Record<string, unknown> = {};
      for (const name of ['firstName', 'lastName', 'dob', 'email']) {
        const value = get(name);
        if (value) info[name] = value;
      }
      const country = get('country').toUpperCase();
      if (country) info.country = country;

      // The API models an address as a structured value, and requires a city and
      // a country alongside the street line — a lone free-text line is rejected.
      const line1 = get('addressLine1');
      const city = get('addressCity');
      if (line1 && city && country) {
        const postCode = get('addressPostCode');
        info.address = { line1, city, country, ...(postCode ? { postCode } : {}) };
      }

      void saveDetails(info);
    });

    card.append(form);
    (form.querySelector('input') as HTMLInputElement | null)?.focus();
  }

  function renderCapture(state: Extract<View, { kind: 'capture' }>) {
    card.append(
      el('h2', {}, state.step.label),
      el(
        'p',
        {},
        `Show the ${SIDE_LABEL[state.side] ?? 'front'} of your ${humanise(
          state.docType,
        ).toLowerCase()}. Make sure all four corners are visible.`,
      ),
    );

    const video = el('video', { playsinline: 'true', muted: 'true' }) as HTMLVideoElement;
    video.muted = true;
    card.append(video);

    const file = el('input', { type: 'file', accept: 'image/*' }) as HTMLInputElement;
    file.addEventListener('change', () => {
      const chosen = file.files?.[0];
      if (chosen) showReview(state, chosen);
    });

    const shoot = el('button', { class: 'primary' }, COPY.capture!);
    const pick = el('button', {}, COPY.choosePhoto!);
    const cancel = el('button', {}, COPY.cancel!);

    shoot.addEventListener('click', () => {
      const blob = grabFrame(video);
      if (blob) void blob.then((b) => b && showReview(state, b));
    });
    pick.addEventListener('click', () => file.click());
    cancel.addEventListener('click', () => {
      stopCamera();
      view = { kind: 'checklist' };
      render();
    });

    const actions = el('div', { class: 'actions' });
    actions.append(shoot, pick, cancel);
    card.append(actions, file);

    void openCamera(video, shoot);
  }

  function renderReview(state: Extract<View, { kind: 'review' }>) {
    card.append(el('h2', {}, state.step.label));
    const img = el('img', { class: 'shot', src: state.url, alt: 'The photo you just took' });
    card.append(img, el('p', {}, 'Is everything readable?'));

    const use = el('button', { class: 'primary' }, busy ? COPY.uploading! : COPY.usePhoto!);
    if (busy) use.setAttribute('disabled', 'true');
    use.addEventListener('click', () => void upload(state));

    const retake = el('button', {}, COPY.retake!);
    retake.addEventListener('click', () => {
      URL.revokeObjectURL(state.url);
      startCapture(state.step, state.docType, state.side);
    });

    const actions = el('div', { class: 'actions' });
    actions.append(use, retake);
    card.append(actions);
  }

  function renderDone() {
    const status = applicant?.reviewStatus ?? 'PENDING';
    const review = applicant?.latestReview ?? null;

    if (status === 'APPROVED') {
      card.append(el('h2', {}, COPY.approved!), el('p', {}, COPY.approvedBody!));
    } else if (status === 'REJECTED_FINAL') {
      card.append(el('h2', {}, COPY.rejectedFinal!), el('p', {}, COPY.rejectedFinalBody!));
      if (review?.clientComment) card.append(el('p', {}, review.clientComment));
    } else if (status === 'REJECTED_RETRY') {
      card.append(el('h2', {}, COPY.rejectedRetry!));
      if (review?.clientComment) card.append(el('p', { class: 'lead' }, review.clientComment));
      const again = el('button', { class: 'primary' }, 'Try again');
      again.addEventListener('click', () => {
        notice = null;
        view = { kind: 'loading' };
        render();
        void load();
      });
      card.append(again);
    } else {
      card.append(el('h2', {}, COPY.inReview!), el('p', {}, COPY.inReviewBody!));
    }

    announce(card.querySelector('h2')?.textContent ?? '');
    options.onComplete?.({ status, canResubmit: status === 'REJECTED_RETRY' });
  }

  // --- Camera ---------------------------------------------------------------

  async function openCamera(video: HTMLVideoElement, shoot: HTMLElement) {
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1920 } },
        audio: false,
      });
      video.srcObject = stream;
      await video.play();
    } catch {
      // Denied, absent, or a non-secure context. Uploading a file is a complete
      // path on its own, so this is a downgrade rather than a failure.
      stopCamera();
      video.remove();
      shoot.setAttribute('disabled', 'true');
      notice = { text: COPY.cameraDenied!, tone: 'err' };
      announce(COPY.cameraDenied!);
      render();
    }
  }

  function grabFrame(video: HTMLVideoElement): Promise<Blob | null> | null {
    if (!video.videoWidth) return null;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d')?.drawImage(video, 0, 0);
    return new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.92));
  }

  // --- Transitions ----------------------------------------------------------

  function startCapture(step: Requirement, docType: string, side: string) {
    stopCamera();
    notice = null;
    view = { kind: 'capture', step, docType, side };
    render();
  }

  function showReview(state: Extract<View, { kind: 'capture' }>, blob: Blob) {
    stopCamera();
    emit({ type: 'document_captured', stepId: state.step.id, documentType: state.docType });
    view = {
      kind: 'review',
      step: state.step,
      docType: state.docType,
      side: state.side,
      blob,
      url: URL.createObjectURL(blob),
    };
    render();
  }

  async function upload(state: Extract<View, { kind: 'review' }>) {
    busy = true;
    notice = null;
    render();
    try {
      await client.uploadDocument({
        file: state.blob,
        filename: `${state.docType.toLowerCase()}-${state.side.toLowerCase()}.jpg`,
        type: state.docType,
        subType: state.side,
        capturedBy: 'WEB_SDK_CAMERA',
      });
      URL.revokeObjectURL(state.url);
      emit({
        type: 'document_uploaded',
        stepId: state.step.id,
        documentType: state.docType,
      });

      // A document requiring both sides needs the back before the step is done.
      if (state.step.requireBothSides && state.side === 'FRONT_SIDE') {
        busy = false;
        startCapture(state.step, state.docType, 'BACK_SIDE');
        return;
      }

      requirements = await client.requirements();
      busy = false;
      view = { kind: 'checklist' };
      announce('Uploaded.');
    } catch (error) {
      busy = false;
      fail(error);
    }
    render();
  }

  async function saveDetails(info: Record<string, unknown>) {
    busy = true;
    notice = null;
    render();
    try {
      await client.updateInfo(info);
      requirements = await client.requirements();
      busy = false;
      view = { kind: 'checklist' };
      announce('Details saved.');
    } catch (error) {
      busy = false;
      fail(error);
    }
    render();
  }

  async function doSubmit() {
    busy = true;
    render();
    try {
      const result = await client.submit();
      emit({ type: 'submitted', status: result.applicant?.reviewStatus });
      applicant = await client.status();
      busy = false;
      view = { kind: 'done' };
      emit({ type: 'status_changed', status: applicant.reviewStatus });
    } catch (error) {
      busy = false;
      fail(error);
    }
    render();
  }

  render();
  void load();

  return {
    destroy() {
      destroyed = true;
      stopCamera();
      if (view.kind === 'review') URL.revokeObjectURL(view.url);
      root.replaceChildren();
    },
    async refresh() {
      await load();
    },
  };
}

// --- Small DOM helpers ------------------------------------------------------

function el(tag: string, attrs: Record<string, string> = {}, text?: string): HTMLElement {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value !== '') node.setAttribute(key, value);
  }
  if (text !== undefined) node.textContent = text;
  return node;
}

function humanise(value: string): string {
  const lower = value.replace(/_/g, ' ').toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

function defaultSide(docType: string): string {
  return ['UTILITY_BILL', 'BANK_STATEMENT', 'TAX_DOCUMENT', 'PROOF_OF_ADDRESS'].includes(docType)
    ? 'PAGE'
    : 'FRONT_SIDE';
}
