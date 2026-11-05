/** Small local SVGs: no font, image request, or remote icon dependency. */
function icon(name: "eye" | "eye-off" | "die"): SVGSVGElement {
  const namespace = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(namespace, "svg");
  for (const [key, value] of Object.entries({
    viewBox: "0 0 24 24",
    width: "24",
    height: "24",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "1.8",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
    focusable: "false",
  }))
    svg.setAttribute(key, value);
  const shape = (tag: string, attributes: Record<string, string>) => {
    const node = document.createElementNS(namespace, tag);
    for (const [key, value] of Object.entries(attributes))
      node.setAttribute(key, value);
    svg.append(node);
  };
  if (name === "die") {
    shape("rect", { x: "3", y: "3", width: "18", height: "18", rx: "4" });
    for (const [cx, cy] of [
      [8, 8],
      [16, 8],
      [12, 12],
      [8, 16],
      [16, 16],
    ])
      shape("circle", {
        cx: String(cx),
        cy: String(cy),
        r: "1.2",
        fill: "currentColor",
        stroke: "none",
      });
  } else {
    shape("path", { d: "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" });
    shape("circle", { cx: "12", cy: "12", r: "3" });
    if (name === "eye-off") shape("path", { d: "M3 3l18 18" });
  }
  return svg;
}

export function showPasswordControl(
  button: HTMLButtonElement,
  visible: boolean,
): void {
  const label = visible ? "Hide password" : "Show password";
  button.replaceChildren(icon(visible ? "eye-off" : "eye"));
  button.setAttribute("aria-label", label);
  button.setAttribute("aria-pressed", String(visible));
  button.title = label;
}

export function generatePasswordControl(button: HTMLButtonElement): void {
  button.replaceChildren(icon("die"));
  button.setAttribute("aria-label", "Generate password");
  button.title = "Generate password";
}
