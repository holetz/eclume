// Build the DOM without innerHTML: text from the server or disk never becomes markup.

/** Create an element. `attrs` accepts normal attributes, `class`, `dataset` (an object), `on`
 * (an event object) and booleans (`true` sets an empty attribute, `false`/`null` omits it).
 * Children can be nodes, text or lists; `null` and `false` are ignored. */
export function el(tag, attrs = {}, ...children) {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs ?? {})) {
    if (value == null || value === false) continue;
    if (name === "dataset") Object.assign(element.dataset, value);
    else if (name === "on") for (const [event, fn] of Object.entries(value)) element.addEventListener(event, fn);
    else if (name === "class") element.className = value;
    else if (name in element && typeof value !== "string") element[name] = value;
    else element.setAttribute(name, value === true ? "" : value);
  }
  append(element, children);
  return element;
}

function append(parent, children) {
  for (const child of children) {
    if (child == null || child === false) continue;
    if (Array.isArray(child)) append(parent, child);
    else parent.append(child instanceof Node ? child : String(child));
  }
}

/** Replace the children of `parent`. */
export function replace(parent, ...children) {
  parent.replaceChildren();
  append(parent, children);
}

/** The element in `root` matching the selector; fail loudly if the markup changed. */
export function $(selector, root = document) {
  const element = root.querySelector(selector);
  if (!element) throw new Error(`elemento ausente: ${selector}`);
  return element;
}
