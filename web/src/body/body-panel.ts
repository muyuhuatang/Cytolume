/*
 * Cytolume's fixed HRA body panel uses the committed snapshot in public/vendor/hra.
 * The pinned component, API responses, and models are served by this site.
 * See hra-snapshot.ts and public/hra-scene-sw.js for the local static API adapter.
 *
 * Keep the proven scene-rebuild kick and transparent ShadowDOM canvas handling:
 * these address rendering races inside the upstream component.
 */
import { type BodySex, referenceBodyIri, referenceOrganIri, bodyNodeLabel } from "./body-map.ts";
import { loadHraBody, setHraBodySex, hraAttributionUrl, observeHraModels } from "./hra-snapshot.ts";
import type { ModelDownloadState } from "./model-progress.ts";

export type { BodySex };

/** Theme background values (mirror style.css --canvas). */
const THEME_BG: Record<"light" | "dark", string> = { light: "#EEF0F3", dark: "#0B0E14" };
/** Stable data-item ids. */
const BODY_ID = "body";
const ORGAN_ID = "organ";
/** Zoom about the centre for organ prominence (keeps the centring). */
const ORGAN_SCALE = 1.22;
/** Per-sex horizontal correction for the /v1/scene auto-frame offset. */
const ORGAN_X_NUDGE: Record<BodySex, string> = { female: "-16.5%", male: "18%" };
/** The organ placed (unhighlit) at rest so the scene keeps TWO distinct targets. */
const DEFAULT_ORGAN = "lung";

/** The element's typed input surface (confirmed in the bundle). */
interface CcfBodyUiElement extends HTMLElement {
  data?: unknown;
  highlightID?: string;
  zoomToID?: string;
}

interface BodyScene {
  data: unknown;
  highlightID: string;
  zoomToID: string;
  /** Reference-organ @ids this scene is about (skin + the placed organ). */
  sceneAllow: string[];
  glow: "rest" | "body-selected" | "organ";
}

/** One <ccf-body-ui-wc> data item: an id + a CCF SpatialEntity placement target. */
function bodyItem(id: string, targetIri: string): unknown {
  const CTX = "https://hubmapconsortium.github.io/ccf-ontology/ccf-context.jsonld";
  const PURL = `http://purl.org/ccf/1.5/cytolume-${id}`;
  return {
    id,
    rui_location: {
      "@context": CTX,
      "@id": PURL,
      "@type": "SpatialEntity",
      ccf_annotations: [],
      dimension_units: "millimeter",
      x_dimension: 10,
      y_dimension: 10,
      z_dimension: 10,
      placement: {
        "@context": CTX,
        "@id": `${PURL}_placement`,
        "@type": "SpatialPlacement",
        source: PURL,
        target: targetIri,
        rotation_order: "XYZ",
        rotation_units: "degree",
        scaling_units: "ratio",
        translation_units: "millimeter",
        x_rotation: 0,
        y_rotation: 0,
        z_rotation: 0,
        x_scaling: 1,
        y_scaling: 1,
        z_scaling: 1,
        x_translation: 0,
        y_translation: 0,
        z_translation: 0,
      },
    },
  };
}

/** Walk an element's (nested) shadow roots + light DOM to find the deck.gl canvas. */
function deepFindCanvas(root: Element | null): HTMLCanvasElement | null {
  if (!root) return null;
  const stack: Element[] = [root];
  while (stack.length) {
    const n = stack.pop();
    if (!n) continue;
    if (n.tagName === "CANVAS") return n as HTMLCanvasElement;
    if (n.shadowRoot) stack.push(...Array.from(n.shadowRoot.children));
    stack.push(...Array.from(n.children));
  }
  return null;
}


/** The Body Location card. */
export class BodyPanel {
  readonly el: HTMLDivElement;
  private readonly stageEl: HTMLDivElement;
  private readonly captionEl: HTMLDivElement;
  private readonly statusEl: HTMLDivElement;
  private readonly statusLabel: HTMLDivElement;
  private readonly statusDetail: HTMLDivElement;
  private readonly progressEl: HTMLProgressElement;
  private readonly retryButton: HTMLButtonElement;
  private readonly sexButtons: Partial<Record<BodySex, HTMLButtonElement>> = {};

  private bodyEl: CcfBodyUiElement | null = null;
  private theme: "light" | "dark";
  private viewSex: BodySex;
  private currentId: string | null = null;
  private ready = false;
  private failed = false;
  private modelError = false;
  private destroyed = false;
  private downloads?: Awaited<ReturnType<typeof observeHraModels>>;
  private sexPending = false;
  private sexChange = 0;
  private canvasPoll: number | null = null;
  /** Pending scene-rebuild kick (see kickSceneRebuild). */
  private kickTimer: number | null = null;

  constructor(parent: HTMLElement = document.body) {
    this.theme = document.documentElement.dataset.theme === "light" ? "light" : "dark";
    this.viewSex =
      new URLSearchParams(window.location.search).get("sex") === "male" ? "male" : "female";

    const el = document.createElement("div");
    el.className = "cyto-body";

    const head = document.createElement("div");
    head.className = "cyto-body-head";
    const title = document.createElement("span");
    title.className = "cyto-body-title";
    title.textContent = "Anatomy";
    const tag = document.createElement("span");
    tag.className = "cyto-body-tag";
    tag.textContent = "Demo mapping";
    tag.title = "HRA reference anatomy with illustrative cell-to-organ links for this demo.";
    head.append(title, tag);

    const sexes = document.createElement("div");
    sexes.className = "cyto-body-modes";
    sexes.setAttribute("role", "group");
    sexes.setAttribute("aria-label", "Body sex");
    const SEX_LABELS: Array<[BodySex, string, string]> = [
      ["female", "Female", "Show the female reference body."],
      ["male", "Male", "Show the male reference body."],
    ];
    for (const [sex, label, hint] of SEX_LABELS) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "cyto-body-mode-btn";
      btn.textContent = label;
      btn.title = hint;
      btn.setAttribute("aria-pressed", String(sex === this.viewSex));
      btn.classList.toggle("is-active", sex === this.viewSex);
      btn.addEventListener("click", () => this.setSex(sex));
      this.sexButtons[sex] = btn;
      sexes.appendChild(btn);
    }

    const stageEl = document.createElement("div");
    stageEl.className = "cyto-body-stage";
    stageEl.setAttribute("aria-busy", "true");
    stageEl.style.background = THEME_BG[this.theme];
    stageEl.addEventListener("contextmenu", (e) => e.preventDefault());
    const loading = document.createElement("div");
    loading.className = "cyto-body-status";
    const statusLabel = document.createElement("div");
    statusLabel.className = "cyto-body-status-label";
    statusLabel.setAttribute("role", "status");
    statusLabel.textContent = "Preparing anatomy…";
    const progress = document.createElement("progress");
    progress.setAttribute("aria-label", "Anatomy download");
    const statusDetail = document.createElement("div");
    statusDetail.className = "cyto-body-status-detail";
    statusDetail.textContent = "You can explore the cell map while this loads.";
    const retry = document.createElement("button");
    retry.type = "button";
    retry.textContent = "Reload page";
    retry.hidden = true;
    retry.addEventListener("click", () => window.location.reload());
    loading.append(statusLabel, progress, statusDetail, retry);
    stageEl.appendChild(loading);

    const captionEl = document.createElement("div");
    captionEl.className = "cyto-body-caption";
    captionEl.textContent = "Select a cell to explore anatomy";

    const note = document.createElement("div");
    note.className = "cyto-body-note";
    note.textContent = "Reference anatomy; illustrative cell links.";

    const credit = document.createElement("a");
    credit.className = "cyto-body-credit";
    credit.href = hraAttributionUrl;
    credit.target = "_blank";
    credit.rel = "noopener";
    credit.textContent = "Anatomy: HRA · CC BY 4.0";
    el.append(head, sexes, stageEl, captionEl, note, credit);
    parent.appendChild(el);

    this.el = el;
    this.stageEl = stageEl;
    this.captionEl = captionEl;
    this.statusEl = loading;
    this.statusLabel = statusLabel;
    this.statusDetail = statusDetail;
    this.progressEl = progress;
    this.retryButton = retry;

    void this.init();
  }

  private async init(): Promise<void> {
    try {
      await loadHraBody(this.viewSex);
      if (this.destroyed) return;
      this.downloads = await observeHraModels(state => this.updateDownload(state));
      if (this.destroyed) { this.downloads.disconnect(); return; }
      // A toggle can change while an asynchronous worker handshake is in flight.
      for (;;) {
        const sex = this.viewSex;
        await setHraBodySex(sex);
        if (this.destroyed) return;
        if (sex === this.viewSex) break;
      }
      this.mountScene(this.sceneFor());
      this.ready = true;
    } catch (err) {
      this.showFailure(err);
    }
  }

  private showFailure(err: unknown): void {
    if (this.destroyed) return;
    this.failed = true;
    this.ready = false;
    if (this.canvasPoll !== null) clearInterval(this.canvasPoll);
    if (this.kickTimer !== null) clearTimeout(this.kickTimer);
    this.downloads?.disconnect();
    this.showDownloadError("Anatomy unavailable", "Reload the page to try again.");
    this.statusEl.title = String(err instanceof Error ? err.message : err);
    this.stageEl.replaceChildren(this.statusEl);
  }

  private showDownloadError(label: string, detail: string): void {
    this.statusEl.hidden = false;
    this.statusEl.classList.add("is-error");
    this.statusLabel.textContent = label;
    this.statusDetail.textContent = detail;
    this.progressEl.hidden = true;
    this.retryButton.hidden = false;
    this.stageEl.setAttribute("aria-busy", "false");
  }

  private updateDownload(state: ModelDownloadState): void {
    if (this.destroyed) return;
    this.modelError = state.error;
    if (state.error) {
      this.showDownloadError("Anatomy download interrupted", "The cell map is still available. Reload to retry.");
      return;
    }
    this.stageEl.setAttribute("aria-busy", String(!state.complete));
    this.statusEl.hidden = state.complete;
    this.statusEl.classList.remove("is-error");
    this.retryButton.hidden = true;
    this.progressEl.hidden = false;
    if (state.complete) return;
    if (this.statusLabel.textContent !== "Loading anatomy…") this.statusLabel.textContent = "Loading anatomy…";
    this.progressEl.max = state.total || 1;
    this.progressEl.value = state.loaded;
    const mib = (bytes: number): string => (bytes / (1024 * 1024)).toFixed(1);
    this.statusDetail.textContent = `${mib(state.loaded)} / ${mib(state.total)} MiB · you can keep exploring`;
  }

  /** The scene for the current selection + sex: ALWAYS two items, [skin, organ]. */
  private sceneFor(): BodyScene {
    const sex = this.viewSex;
    const skinIri = referenceBodyIri(sex);
    const selectedIri = this.currentId ? referenceOrganIri(this.currentId, sex) : null;
    const organIri = selectedIri ?? referenceOrganIri(DEFAULT_ORGAN, sex) ?? skinIri;
    const showingOrgan = !!selectedIri;
    return {
      data: [bodyItem(BODY_ID, skinIri), bodyItem(ORGAN_ID, organIri)],
      highlightID: showingOrgan ? ORGAN_ID : BODY_ID,
      zoomToID: BODY_ID,
      sceneAllow: [skinIri, organIri],
      glow: showingOrgan ? "organ" : this.currentId ? "body-selected" : "rest",
    };
  }

  private mountScene(scene: BodyScene): void {
    this.downloads?.expect(scene.sceneAllow);
    const body = document.createElement("ccf-body-ui-wc") as CcfBodyUiElement;
    body.className = "cyto-body-wc";
    body.data = scene.data;
    body.zoomToID = scene.zoomToID;
    if (scene.highlightID) body.highlightID = scene.highlightID;
    this.bodyEl = body;
    this.centerBody();
    this.applyGlow(scene.glow);
    this.stageEl.replaceChildren(body, this.statusEl);
    this.startCanvasTransparencyPoll();
    this.kickSceneRebuild(scene);
  }

  /** Frame the body: fill the stage, correct the per-sex auto-frame offset, zoom in. */
  private centerBody(): void {
    const el = this.bodyEl;
    if (!el) return;
    el.style.position = "absolute";
    el.style.top = "0";
    el.style.left = "0";
    el.style.width = "100%";
    el.style.height = "100%";
    el.style.transformOrigin = "center center";
    el.style.transform = `translateX(${ORGAN_X_NUDGE[this.viewSex]}) scale(${ORGAN_SCALE})`;
  }

  private applyGlow(glow: BodyScene["glow"]): void {
    const el = this.bodyEl;
    if (!el) return;
    el.style.filter =
      glow === "organ"
        ? "saturate(1.05) brightness(1.04)"
        : glow === "body-selected"
          ? "saturate(0.85) brightness(1.02)"
          : "saturate(0.72) brightness(0.99)";
  }

  /** Force the inner deck.gl canvas transparent so the themed stage shows through. */
  private startCanvasTransparencyPoll(): void {
    if (this.canvasPoll !== null) {
      clearInterval(this.canvasPoll);
      this.canvasPoll = null;
    }
    let tries = 0;
    const tick = (): void => {
      const c = deepFindCanvas(this.bodyEl);
      if (c) {
        c.style.backgroundColor = "transparent";
        if (this.canvasPoll !== null) {
          clearInterval(this.canvasPoll);
          this.canvasPoll = null;
        }
        return;
      }
      if (++tries > 60 && this.canvasPoll !== null) {
        clearInterval(this.canvasPoll);
        this.canvasPoll = null;
      }
    };
    this.canvasPoll = window.setInterval(tick, 200);
    tick();
  }

  /**
   * Re-assign `data` once, shortly after mount, to force the component to rebuild its
   * scene.
   *
   * The component loses a race on first mount: the scene arrives and the organ GLB
   * draws, but the SKIN often never appears — verified by A/B, without this kick the
   * panel shows a floating organ and no body. Re-assigning the same data makes it
   * rebuild and the skin lands. Deliberately UNCONDITIONAL: an earlier version tried
   * to detect "did it draw" first, but the drawing buffer is not readable
   * (preserveDrawingBuffer is false) and resource timing does not tell you whether a
   * mesh was actually rendered, so the detection misfired in both directions. One
   * extra scene fetch is a cheap price for a body that reliably appears.
   */
  private kickSceneRebuild(scene: BodyScene): void {
    // Only ever one pending kick: a rapid series of clicks would otherwise queue a
    // rebuild per click and re-apply stale scenes out of order.
    if (this.kickTimer !== null) clearTimeout(this.kickTimer);
    this.kickTimer = window.setTimeout(() => {
      this.kickTimer = null;
      const el = this.bodyEl;
      if (!el) return;
      el.data = scene.data;
      el.highlightID = scene.highlightID;
      el.zoomToID = scene.zoomToID;
      this.centerBody();
    }, 2200);
  }

  /** Update the mounted element in place (never re-mount: that loses the frame). */
  private applyScene(): void {
    if (this.failed || this.destroyed) return;
    const scene = this.sceneFor();
    this.downloads?.expect(scene.sceneAllow);
    if (!this.bodyEl) {
      if (this.ready) this.mountScene(scene);
      return;
    }
    const el = this.bodyEl;
    el.data = scene.data;
    el.highlightID = scene.highlightID;
    el.zoomToID = scene.zoomToID;
    this.centerBody();
    this.applyGlow(scene.glow);
    const c = deepFindCanvas(el);
    if (c) c.style.backgroundColor = "transparent";
    // A selection change re-fetches the scene, so it loses the SAME race the first
    // mount does — without this the panel can end up showing a floating organ with
    // no body around it.
    this.kickSceneRebuild(scene);
  }

  highlight(nodeId: string | null): void {
    this.currentId = nodeId;
    const label = nodeId ? bodyNodeLabel(nodeId) : undefined;
    this.captionEl.textContent = nodeId
      ? `Demo link: ${label ?? nodeId}`
      : "Select a cell to explore anatomy";
    if (!this.sexPending) this.applyScene();
  }

  setSex(sex: BodySex): void {
    const next: BodySex = sex === "male" ? "male" : "female";
    this.viewSex = next;
    for (const s of ["female", "male"] as const) {
      const btn = this.sexButtons[s];
      if (!btn) continue;
      const on = s === next;
      btn.classList.toggle("is-active", on);
      btn.setAttribute("aria-pressed", String(on));
    }
    const p = new URLSearchParams(window.location.search);
    p.set("sex", next);
    history.replaceState(null, "", `${window.location.pathname}?${p.toString()}`);
    this.currentId = null;
    this.captionEl.textContent = "Select a cell to explore anatomy";
    if (!this.ready) return; // init() will use the current choice.
    this.sexPending = true;
    const change = ++this.sexChange;
    void setHraBodySex(next).then(() => {
      if (this.destroyed || change !== this.sexChange) return;
      this.sexPending = false;
      if (!this.failed) this.applyScene();
    }).catch(err => { if (change === this.sexChange) this.showFailure(err); });
  }

  setTheme(theme: "light" | "dark"): void {
    this.theme = theme === "light" ? "light" : "dark";
    this.stageEl.style.background = THEME_BG[this.theme];
    const c = deepFindCanvas(this.bodyEl);
    if (c) c.style.backgroundColor = "transparent";
  }

  get isReady(): boolean {
    return this.ready;
  }
  get isFailed(): boolean {
    return this.failed || this.modelError;
  }
  get highlightedId(): string | null {
    return this.currentId;
  }
  get elementHighlightID(): string | undefined {
    return this.bodyEl?.highlightID;
  }
  get stage(): HTMLDivElement {
    return this.stageEl;
  }

  destroy(): void {
    this.destroyed = true;
    this.downloads?.disconnect();
    if (this.canvasPoll !== null) clearInterval(this.canvasPoll);
    if (this.kickTimer !== null) clearTimeout(this.kickTimer);
    this.el.remove();
  }
}
