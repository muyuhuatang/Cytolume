/** A small, reopenable introduction shared by both views. */
export function setupQuickStart(view: "2d" | "3d"): void {
  const guide = document.getElementById("quick-start") as HTMLDetailsElement | null;
  if (!guide) return;
  const key = `cytolume:quick-start:v1:${import.meta.env.BASE_URL}`;
  if (view === "2d") {
    const copy: Record<string, string> = {
      "guide-move-title": "Explore the map",
      "guide-move": "Drag to pan; scroll to zoom.",
      "guide-select-title": "Compare populations",
      "guide-select": "Choose Cell type under Encoding to see categories in color.",
      "guide-context-title": "Try the 3D view",
      "guide-context": "Switch to 3D under View for cell selection and anatomical context.",
    };
    for (const [id, text] of Object.entries(copy)) {
      const element = document.getElementById(id);
      if (element) element.textContent = text;
    }
  }
  // Storage can be unavailable in private or restricted browsing. The guide still works.
  try { guide.open = localStorage.getItem(key) !== "dismissed"; } catch { /* Keep the introduction open. */ }
  guide.addEventListener("toggle", () => {
    if (!guide.open) {
      try { localStorage.setItem(key, "dismissed"); } catch { /* Optional preference only. */ }
    }
  });
  document.getElementById("guide-dismiss")?.addEventListener("click", () => {
    guide.open = false;
    guide.querySelector("summary")?.focus();
  });
}
