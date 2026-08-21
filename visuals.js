// ---------------- visuals.js ----------------
// Small, reusable, DATA-driven diagram + step-through-animation renderer.
// No hand-drawn art: every visual is plain SVG built from a shapes/connectors
// data object, same spirit as the app's existing card/quiz JSON. Two visual
// types today: "diagram" (static) and "animation" (a sequence of diagram
// frames stepped through with Prev/Next, like the lesson cards themselves).

const VISUAL_COLORS = {
  entity: { fill: "#eaf6ff", stroke: "#1cb0f6" },
  "weak-entity": { fill: "#eaf6ff", stroke: "#1cb0f6" },
  relationship: { fill: "#fff7e6", stroke: "#d99a1b" },
  attribute: { fill: "#f2f2f2", stroke: "#8a8a8a" },
  "key-attribute": { fill: "#f2f2f2", stroke: "#8a8a8a" },
  multivalued: { fill: "#f2f2f2", stroke: "#8a8a8a" },
  table: { fill: "#eefaf0", stroke: "#46a302" },
  note: { fill: "none", stroke: "none" },
  circle: { fill: "#eaf6ff", stroke: "#1cb0f6" },
};

function vEsc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Clip a ray from box-center (cx,cy) toward (tx,ty) to the box's boundary.
function clipToBox(cx, cy, hw, hh, tx, ty) {
  const dx = tx - cx, dy = ty - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  const sx = dx !== 0 ? hw / Math.abs(dx) : Infinity;
  const sy = dy !== 0 ? hh / Math.abs(dy) : Infinity;
  const s = Math.min(sx, sy);
  return { x: cx + dx * s, y: cy + dy * s };
}

function shapeCenter(s) {
  return { x: s.x + s.w / 2, y: s.y + s.h / 2 };
}

function renderShapeSVG(s) {
  const base = VISUAL_COLORS[s.type] || VISUAL_COLORS.entity;
  const colors = s.fill ? { fill: s.fill, stroke: s.stroke || s.fill } : base;
  const cx = s.x + s.w / 2, cy = s.y + s.h / 2;
  let shapeMarkup = "";

  if (s.type === "circle") {
    const r = s.w / 2;
    const fill = s.filled === false ? "none" : colors.fill;
    const opacity = s.opacity != null ? s.opacity : 1;
    shapeMarkup = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}" fill-opacity="${opacity}" stroke="${colors.stroke}" stroke-width="2"/>`;
  } else if (s.type === "entity" || s.type === "weak-entity") {
    shapeMarkup = `<rect x="${s.x}" y="${s.y}" width="${s.w}" height="${s.h}" rx="8" fill="${colors.fill}" stroke="${colors.stroke}" stroke-width="2"/>`;
    if (s.type === "weak-entity") {
      shapeMarkup += `<rect x="${s.x + 5}" y="${s.y + 5}" width="${s.w - 10}" height="${s.h - 10}" rx="5" fill="none" stroke="${colors.stroke}" stroke-width="1.5"/>`;
    }
  } else if (s.type === "relationship") {
    const points = `${cx},${s.y} ${s.x + s.w},${cy} ${cx},${s.y + s.h} ${s.x},${cy}`;
    shapeMarkup = `<polygon points="${points}" fill="${colors.fill}" stroke="${colors.stroke}" stroke-width="2"/>`;
  } else if (s.type === "attribute" || s.type === "key-attribute" || s.type === "multivalued") {
    const rx = s.w / 2, ry = s.h / 2;
    shapeMarkup = `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="${colors.fill}" stroke="${colors.stroke}" stroke-width="1.5"/>`;
    if (s.type === "multivalued") {
      shapeMarkup += `<ellipse cx="${cx}" cy="${cy}" rx="${rx - 4}" ry="${ry - 4}" fill="none" stroke="${colors.stroke}" stroke-width="1.2"/>`;
    }
  } else if (s.type === "table") {
    const rows = s.rows || [];
    const rowH = (s.h - 26) / Math.max(rows.length, 1);
    shapeMarkup = `<rect x="${s.x}" y="${s.y}" width="${s.w}" height="${s.h}" rx="6" fill="${colors.fill}" stroke="${colors.stroke}" stroke-width="2"/>`;
    shapeMarkup += `<rect x="${s.x}" y="${s.y}" width="${s.w}" height="26" rx="6" fill="${colors.stroke}"/>`;
    shapeMarkup += `<rect x="${s.x}" y="${s.y + 14}" width="${s.w}" height="12" fill="${colors.stroke}"/>`;
    shapeMarkup += `<text x="${cx}" y="${s.y + 17}" text-anchor="middle" font-size="12" font-weight="700" fill="#fff">${vEsc(s.label)}</text>`;
    rows.forEach((r, i) => {
      const ry = s.y + 26 + rowH * i;
      shapeMarkup += `<text fill="#2b2b2b" x="${s.x + 8}" y="${ry + rowH / 2 + 4}" font-size="11">${vEsc(r)}</text>`;
      if (i > 0) shapeMarkup += `<line x1="${s.x}" y1="${ry}" x2="${s.x + s.w}" y2="${ry}" stroke="${colors.stroke}" stroke-width="0.75" opacity="0.4"/>`;
    });
    return shapeMarkup; // table draws its own label inside the header, skip generic label below
  } else if (s.type === "note") {
    return `<text fill="#5a5a5a" x="${cx}" y="${cy}" text-anchor="middle" font-size="12" font-style="italic">${vEsc(s.label)}</text>`;
  }

  let labelMarkup = "";
  if (s.label) {
    const lines = String(s.label).split("\n");
    const lineH = 14;
    const startY = cy - ((lines.length - 1) * lineH) / 2 + 4 + (s.labelDy || 0);
    labelMarkup = lines
      .map((line, i) => `<text fill="#2b2b2b" x="${cx}" y="${startY + i * lineH}" text-anchor="middle" font-size="12" font-weight="${s.type === "entity" || s.type === "weak-entity" || s.type === "relationship" || s.type === "circle" ? 700 : 500}">${vEsc(line)}</text>`)
      .join("");
    if (s.type === "key-attribute") {
      const w = Math.max(...lines.map(l => l.length)) * 6.2;
      labelMarkup += `<line stroke="#2b2b2b" x1="${cx - w / 2}" y1="${startY + 6}" x2="${cx + w / 2}" y2="${startY + 6}" stroke-width="1"/>`;
    }
  }
  return shapeMarkup + labelMarkup;
}

// The lens (vesica) where two circles overlap, as an SVG path — used for
// Venn-style join diagrams to highlight exactly the "matched" region.
function circleLensPath(a, b) {
  const ax = a.x + a.w / 2, ay = a.y + a.h / 2, ar = a.w / 2;
  const bx = b.x + b.w / 2, by = b.y + b.h / 2, br = b.w / 2;
  const dx = bx - ax, dy = by - ay;
  const d = Math.sqrt(dx * dx + dy * dy);
  if (d >= ar + br || d <= Math.abs(ar - br) || d === 0) return null;
  const aDist = (d * d - br * br + ar * ar) / (2 * d);
  const h = Math.sqrt(Math.max(ar * ar - aDist * aDist, 0));
  const px = ax + (aDist * dx) / d, py = ay + (aDist * dy) / d;
  const perpx = -dy / d, perpy = dx / d;
  const p1 = { x: px + h * perpx, y: py + h * perpy };
  const p2 = { x: px - h * perpx, y: py - h * perpy };
  return `M ${p1.x} ${p1.y} A ${ar} ${ar} 0 0 1 ${p2.x} ${p2.y} A ${br} ${br} 0 0 1 ${p1.x} ${p1.y} Z`;
}

function renderRegionSVG(shapesById, r) {
  if (r.type === "intersection") {
    const a = shapesById[r.a], b = shapesById[r.b];
    if (!a || !b) return "";
    const path = circleLensPath(a, b);
    if (!path) return "";
    return `<path d="${path}" fill="${r.fill || "#58cc02"}" fill-opacity="${r.opacity != null ? r.opacity : 0.85}"/>`;
  }
  return "";
}

function renderConnectorSVG(shapesById, c) {
  const a = shapesById[c.from], b = shapesById[c.to];
  if (!a || !b) return "";
  const ca = shapeCenter(a), cb = shapeCenter(b);
  const p1 = clipToBox(ca.x, ca.y, a.w / 2, a.h / 2, cb.x, cb.y);
  const p2 = clipToBox(cb.x, cb.y, b.w / 2, b.h / 2, ca.x, ca.y);
  const dash = c.style === "dashed" ? ` stroke-dasharray="5,4"` : "";
  const strokeW = c.style === "double" ? 3 : 1.5;
  let line = `<line stroke="#5a5a5a" x1="${p1.x}" y1="${p1.y}" x2="${p2.x}" y2="${p2.y}" stroke-width="${strokeW}"${dash}/>`;
  let labelMarkup = "";
  if (c.label) {
    const mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2;
    const w = String(c.label).length * 6.5 + 6;
    labelMarkup = `<rect fill="#f7f7f7" x="${mx - w / 2}" y="${my - 9}" width="${w}" height="16"/><text fill="#5a5a5a" x="${mx}" y="${my + 3}" text-anchor="middle" font-size="11" font-weight="600">${vEsc(c.label)}</text>`;
  }
  return line + labelMarkup;
}

function renderFrameSVG(frame, width, height) {
  const shapesById = {};
  (frame.shapes || []).forEach(s => { shapesById[s.id] = s; });
  const connectorsMarkup = (frame.connectors || []).map(c => renderConnectorSVG(shapesById, c)).join("");
  const shapesMarkup = (frame.shapes || []).map(renderShapeSVG).join("");
  const regionsMarkup = (frame.regions || []).map(r => renderRegionSVG(shapesById, r)).join("");
  // connectors first, then shapes, then regions (e.g. a Venn lens) drawn on top of both
  // explicit width/height (not just viewBox) so browsers don't collapse the box before CSS height:auto resolves
  return `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" preserveAspectRatio="xMidYMid meet" class="visual-svg" xmlns="http://www.w3.org/2000/svg">${connectorsMarkup}${shapesMarkup}${regionsMarkup}</svg>`;
}

// Public: returns the HTML string to splice into a card's innerHTML.
function renderVisualHTML(visual, uid) {
  const width = visual.width || 700;
  const height = visual.height || 380;
  if (visual.type === "diagram") {
    return `<div class="visual-block"><div class="visual-frame">${renderFrameSVG(visual, width, height)}</div>${visual.caption ? `<div class="visual-caption">${vEsc(visual.caption)}</div>` : ""}</div>`;
  }
  if (visual.type === "animation") {
    const steps = visual.steps || [];
    return `
      <div class="visual-block visual-animation" data-uid="${uid}" data-step="0">
        <div class="visual-frame">${renderFrameSVG(steps[0] || {}, width, height)}</div>
        <div class="visual-caption">${vEsc((steps[0] || {}).caption || "")}</div>
        <div class="visual-anim-controls">
          <button type="button" class="visual-step-btn" data-dir="-1" disabled>&larr; Back</button>
          <span class="visual-step-indicator">Step 1 of ${steps.length}</span>
          <button type="button" class="visual-step-btn" data-dir="1" ${steps.length <= 1 ? "disabled" : ""}>Next &rarr;</button>
        </div>
      </div>`;
  }
  return "";
}

// Public: call once per rendered card, after its HTML is in the DOM, to wire
// up any animation step controls inside it. No-op for plain "diagram" visuals.
function initVisual(cardEl, visual) {
  if (!visual || visual.type !== "animation") return;
  const block = cardEl.querySelector(".visual-animation");
  if (!block) return;
  const steps = visual.steps || [];
  const width = visual.width || 700;
  const height = visual.height || 380;
  const frameEl = block.querySelector(".visual-frame");
  const captionEl = block.querySelector(".visual-caption");
  const indicatorEl = block.querySelector(".visual-step-indicator");
  const backBtn = block.querySelector('.visual-step-btn[data-dir="-1"]');
  const nextBtn = block.querySelector('.visual-step-btn[data-dir="1"]');

  function paint(stepIndex) {
    block.dataset.step = stepIndex;
    frameEl.innerHTML = renderFrameSVG(steps[stepIndex] || {}, width, height);
    captionEl.textContent = (steps[stepIndex] || {}).caption || "";
    indicatorEl.textContent = `Step ${stepIndex + 1} of ${steps.length}`;
    backBtn.disabled = stepIndex === 0;
    nextBtn.disabled = stepIndex === steps.length - 1;
  }

  [backBtn, nextBtn].forEach(btn => {
    btn.addEventListener("click", () => {
      const cur = parseInt(block.dataset.step, 10);
      const next = Math.min(steps.length - 1, Math.max(0, cur + parseInt(btn.dataset.dir, 10)));
      if (next !== cur) paint(next);
    });
  });
}
